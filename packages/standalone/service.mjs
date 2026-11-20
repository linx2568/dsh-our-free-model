import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { buildComboCatalog, comboChain, isComboEntry, normalizeCombos } from '../../src/combos.js'
import { recordTurn, recordUsage } from '../../src/store.js'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'
import { createSubscriptions } from '../../src/subscriptions.js'
import { createSubscriptionRuntime } from '../../src/subscription-completion.js'
import { createMagpieEngine, findAgentCli } from '../../src/magpie-engine.js'
import { createExtensionRuntime } from '../../src/extensions.js'
import { builtinDescriptors } from '../../src/plugins.js'
import { combineSubscriptionRuntimes, createMagpieModels } from '../../src/magpie-models.js'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ofm-service-lock-${id}` : `\0ofm-service-lock-${id}`
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // 只有 ESRCH 能证明进程已经退出；无权限、PID 复用等情况均保留原锁。
      let exited = false
      try { process.kill(owner.pid, 0) }
      catch (probeError) { exited = probeError.code === 'ESRCH' }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe, lanEnabled, lanPort,
  startRelay = startLanRelay,
  workbenchOptions, subscriptionOptions,
  // The desktop updater judges the host it runs on (`win32` + `x64` only). It
  // already takes `platform`/`arch` at its own boundary, so they are threaded
  // through here rather than re-derived: a test runner is never a Windows x64
  // host, and the update flow has to be exercisable where CI actually runs.
  desktopPlatform = process.platform, desktopArch = process.arch,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  if (lanEnabled !== undefined && typeof lanEnabled !== 'boolean') throw new TypeError('lanEnabled must be a boolean')
  if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)) {
    throw new TypeError('lanPort must be an integer between 0 and 65535')
  }
  if (typeof desktopPlatform !== 'string' || desktopPlatform === '') throw new TypeError('desktopPlatform must be a non-empty string')
  if (typeof desktopArch !== 'string' || desktopArch === '') throw new TypeError('desktopArch must be a non-empty string')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireServiceLock(dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let subscriptions
  let magpieEngine
  let extensions
  let magpieModels
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  let relay
  let relayTarget
  let relayRequestedPort
  let relayError = null
  let relayChanges = Promise.resolve()
  const lanState = () => {
    const value = stores.settings.get()
    const addresses = rankLanAddresses(os.networkInterfaces())
    return {
      enabled: value.standaloneLanEnabled === true,
      running: relay !== undefined,
      host: relay?.host ?? '0.0.0.0',
      requestedPort: value.standaloneLanPort ?? 0,
      port: relay?.port ?? null,
      addresses,
      baseUrls: relay ? addresses.map(address => `http://${address}:${relay.port}/v1`) : [],
      error: relayError,
    }
  }
  async function closeRelay() {
    const current = relay
    const target = relayTarget
    relay = undefined
    relayTarget = undefined
    relayRequestedPort = undefined
    await Promise.all([current?.close(), target?.close()])
  }
  function reconcileRelay() {
    relayChanges = relayChanges.then(async () => {
      const value = stores.settings.get()
      const wantedPort = value.standaloneLanPort ?? 0
      relayError = null
      if (stopped || value.enabled === false || value.standaloneLanEnabled !== true) {
        await closeRelay()
        return
      }
      if (relay && relayRequestedPort === wantedPort) return
      await closeRelay()
      try {
        if (typeof value.standaloneLanKey !== 'string' || value.standaloneLanKey === '' ||
            value.standaloneLanKey === value.forwardKey) {
          settingsPersist({ standaloneLanKey: generateKey() })
        }
        // The shared relay targets IPv4 loopback. An IPv6 management bind needs
        // a separate inference-only loopback target, with no management handler.
        if (listener.server.address().address !== '127.0.0.1') {
          relayTarget = await startForwardServer({
            config: () => ({
              host: '127.0.0.1', port: 0,
              enabled: !stopped && stores.settings.get().enabled !== false,
              key: stores.settings.get().forwardKey,
            }),
            complete: runtime.complete, modelRows: runtime.publicModelRows,
          })
        }
        const targetPort = relayTarget?.port ?? listener.port
        const started = await startRelay({
          config: () => ({
            enabled: !stopped && stores.settings.get().enabled !== false && stores.settings.get().standaloneLanEnabled === true,
            host: '0.0.0.0', port: wantedPort, targetPort,
            lanKey: stores.settings.get().standaloneLanKey,
            localKey: stores.settings.get().forwardKey,
          }),
          log: message => logger.warn?.(`our-free-model standalone LAN: ${message}`),
        })
        relay = started
        relayRequestedPort = wantedPort
        if (stopped || stores.settings.get().enabled === false || stores.settings.get().standaloneLanEnabled !== true) await closeRelay()
      } catch (error) {
        await closeRelay()
        relayError = `LAN relay could not start (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'START_FAILED'})`
        logger.warn?.(relayError)
      }
    })
    return relayChanges
  }
  function settingsPersist(patch) {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist the standalone LAN settings')
    }
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    const savedLanPort = settings.get().standaloneLanPort
    settings.update({
      forwardKey: key,
      managementKey: typeof settings.get().managementKey === 'string' && settings.get().managementKey !== ''
        && settings.get().managementKey !== key ? settings.get().managementKey : generateKey(),
      standaloneLanEnabled: lanEnabled ?? settings.get().standaloneLanEnabled === true,
      standaloneLanPort: lanPort ?? (Number.isInteger(savedLanPort) && savedLanPort >= 0 && savedLanPort <= 65535 ? savedLanPort : 0),
      ...probe === undefined ? {} : { standaloneProbe: probe === true },
    })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    eac = createStandaloneEac({
      dataDir,
      ...process.env.OFM_TEST_UPSTREAM ? { openExternal: async () => false } : {},
      onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
    })
    subscriptions = createSubscriptions({ dataDir, ...subscriptionOptions })
    const subscriptionRuntime = createSubscriptionRuntime({ subscriptions, stats: stores.stats, logger })
    // The model workspace: the same embedded engine the plugin's settings page
    // uses, so both products answer "which providers, which models" the same way.
    magpieEngine = createMagpieEngine({ dataDir, logger })
    // The extension runtime is created just below; the lazy reference gives the
    // magpie lane the enhancement-hook seam without reordering boot.
    let extensionHookRuntime = null
    magpieModels = createMagpieModels({
      engine: magpieEngine, stats: stores.stats, logger,
      onChanged: () => runtime?.syncAggregateCatalog?.(),
      extensionRuntime: () => extensionHookRuntime,
    })
    const combinedSubscriptionRuntime = combineSubscriptionRuntimes(magpieModels, subscriptionRuntime)
    // The OFM extension platform, same as the plugin's: the marketplace client,
    // the sandboxed channel host, and the lane they contribute.
    extensions = createExtensionRuntime({
      dataDir, logger, hostVersion: VERSION,
      onCatalogChanged: () => { try { runtime?.syncExtensionCatalog?.() } catch { /* boot ordering */ } },
    })
    extensionHookRuntime = extensions
    // Built-ins register through the same kernel a third-party plugin uses.
    for (const descriptor of builtinDescriptors()) extensions.registerBuiltin(descriptor)
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      sealedCredential: eac.credential,
      subscriptionRuntime: combinedSubscriptionRuntime,
      extensionRuntime: extensions,
    })
    channels = await createChannelRuntime({ dataDir, logger, stats: stores.stats })
    const core = runtime

    const baseCatalog = () => [
      ...core.catalog.filter(row => !isComboEntry(row)),
      ...channels.publicModelRows().map(row => ({ ...row, contextWindow: row.context_window, maxOutput: row.max_tokens })),
    ]
    const getCombos = () => {
      const stored = normalizeCombos(stores.settings.get().combos)
      return buildComboCatalog(stored, baseCatalog())
    }

    runtime = {
      ...core,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      get catalog() { return [...baseCatalog(), ...getCombos()] },
      state: () => ({ ...core.state(), catalog: [...baseCatalog(), ...getCombos()] }),
      publicModelRows: () => [
        ...core.publicModelRows().filter(row => !row.id.startsWith('combo:')),
        ...channels.publicModelRows(),
        ...getCombos().map(entry => ({
          id: entry.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'our-free-model',
          ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
          ...entry.maxOutput === undefined ? {} : { max_tokens: entry.maxOutput },
        })),
      ],
      complete: async (request, onChunk) => {
        const comboEntry = getCombos().find(row => row.id === request.model || row.name === request.model)
        if (comboEntry) {
          const candidates = comboChain(comboEntry, [...baseCatalog(), ...getCombos()], core.state().routing ?? {})
          if (candidates.length === 0) {
            throw Object.assign(new Error(`the chain "${comboEntry.name}" has no model available on this egress`), { statusCode: 502 })
          }
          const tried = []
          // 链主记账：combo 内部失败的那几跳不再各自写样本（见 channels/runtime.mjs
          // 的 `comboHop` 说明），只有「整条链都没成」才留一条用户可见的失败记录 ——
          // 否则「运行检查」里会堆满中间跳的红卡片，而同一秒后面的候选其实已经成功。
          const recordCombo = (model) => {
            if (!stores.stats) return
            try {
              recordUsage(stores.stats, { at: Date.now(), model, ok: false, input: 0, output: 0, reasoning: 0, cacheRead: 0, origin: 'combo' })
              recordTurn(stores.stats, { model, ok: false, recovered: false })
            } catch { /* 统计写失败不能影响这次请求 */ }
          }
          for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index]
            const held = []
            let committed = false
            let outcome
            try {
              const isChannel = channels.handles(candidate.id)
              const dispatch = isChannel
                ? (req, cb) => channels.complete(req, cb)
                : (req, cb) => core.complete(req, cb)
              // comboHop 只对渠道候选生效：渠道运行时据此跳过逐跳记账；
              // core 那条（插件车道）自己按逻辑回合记账，不受影响。
              outcome = await dispatch({ ...request, model: candidate.id, ...isChannel ? { comboHop: true } : {} }, chunk => {
                if (committed) {
                  onChunk?.(chunk)
                  return
                }
                held.push(chunk)
                if (commitsAnswer(chunk)) {
                  committed = true
                  for (const c of held) onChunk?.(c)
                  held.length = 0
                }
              })
            } catch (error) {
              if (committed) throw error
              tried.push(`${candidate.id} (${error.message || error})`)
              logger.warn?.(`our-free-model standalone: chain "${comboEntry.name}" advanced past ${candidate.id} — ${error.message || error}`)
              continue
            }
            if (committed) return outcome
            if (outcome?.error !== undefined) {
              tried.push(`${candidate.id} (${outcome.error})`)
              logger.warn?.(`our-free-model standalone: chain "${comboEntry.name}" advanced past ${candidate.id} — ${outcome.error}`)
              continue
            }
            for (const c of held) onChunk?.(c)
            return outcome
          }
          // 只有「整条链都没成」才记一条失败样本：中途被后续候选救回来的那些跳
          // 已经在 runtime.mjs 里被 `comboHop` 拦掉了，这里补上用户真正遇到的失败。
          recordCombo(comboEntry.id, false)
          throw Object.assign(new Error(`the chain "${comboEntry.name}" exhausted every candidate: ${tried.join('; ')}`), { statusCode: 502 })
        }
        return channels.handles(request.model) ? channels.complete(request, onChunk) : core.complete(request, onChunk)
      },
      async refreshCatalog(options) {
        if (stopped) return
        const [result, channelResult] = await Promise.all([core.refreshCatalog(options), channels.refresh(options).catch(error => { if (!stopped) throw error })])
        if (options?.report) return { ...result, sources: { ...result.sources, ...channelResult?.sources } }
      },
    }
    management = createManagement({
      stores, runtime, channels, eac, subscriptions, workbenchOptions, extensions,
      magpieEngine, magpieModels,
      desktopPlatform, desktopArch,
      onEngineStarted: () => { settings.update({ magpieEnabled: true }); settings.flush() },
      onSubscriptionsChanged: () => runtime?.syncAggregateCatalog?.(),
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true, lan: true, modelWorkspace: true },
        lan: lanState(),
      }),
      onSettingsChanged: async () => {
        if (!refreshInFlight) scheduleRefresh()
        await reconcileRelay()
      },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()
    // Resume the workspace only when it was running at the last shutdown: the
    // engine is a child process, and starting one nobody asked for would spend
    // memory on every launch.
    if (settings.get().magpieEnabled === true) {
      void magpieEngine.start().then(() => magpieModels.refresh()).catch(() => {
        logger.warn?.('our-free-model standalone: model workspace could not resume')
      })
      // Same readiness warning as the plugin: the engine connects Claude through
      // the locally installed Claude Code CLI.
      if (findAgentCli('claude') === undefined) {
        logger.warn?.('our-free-model standalone: 未检测到 Claude Code CLI —— 在模型工作台连接 Claude 前请先安装（npm i -g @anthropic-ai/claude-code）。(Claude Code CLI not found; install it before connecting Claude)')
      }
    }
    void extensions.init().catch(error => {
      logger.warn?.(`our-free-model standalone: extension mount failed (${error?.message ?? error})`)
    })
    if (!process.env.OFM_TEST_UPSTREAM) extensions.startWatching({ intervalMs: 2000 })
    void extensions.refreshRegistry().catch(() => {})
    // The marketplace index refreshes on its own cadence too: an update that
    // lands upstream should reach the Installed tab without the user opening
    // the market first. The TTL cache keeps ticks cheap; failures are silent.
    const registryTimer = setInterval(() => {
      void extensions.refreshRegistry().catch(() => {})
      // Same contract as the plugin side: the automatic updater rides the
      // registry tick and only ever installs a soaked, still-enabled update.
      if (settings.get().autoUpdateExtensions === true) void extensions.autoUpdate().catch(() => {})
    }, 6 * 60 * 60 * 1000)
    registryTimer.unref?.()
    await reconcileRelay()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      // Automatic availability probing is disabled by owner policy: periodic and
      // boot refreshes only reload the listing. The management "probe" action
      // still asks for an explicit probe through the runtime API.
      refreshInFlight = runtime.refreshCatalog({ probe: false, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动与周期刷新只更新清单，不自动探测；手动“探测可用性”仍走运行时 API。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(false) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      get lan() { return lanState() },
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        clearInterval(registryTimer)
        const managementClosing = management.dispose()
        eac.dispose()
        magpieModels?.close()
        const engineClosing = magpieEngine?.close()
        extensions?.dispose()
        runtime.dispose()
        closing = (async () => {
          try {
            await relayChanges
            await Promise.all([managementClosing, closeRelay(), listener.close(), channels.close(), engineClosing])
          } finally {
            try { stores.dispose() } finally { await releaseLock() }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    await management?.dispose()
    eac?.dispose()
    magpieModels?.close()
    await magpieEngine?.close()
    extensions?.dispose()
    runtime?.dispose()
    await relayChanges
    await closeRelay()
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
