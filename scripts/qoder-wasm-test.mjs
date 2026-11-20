/**
 * Qoder WASM 胶水的**真实调用**回归。
 *
 * ⚠️ 为什么需要这个套件：`channel-pack-test` 里的 Qoder 用例把
 * `QoderEncryptedInfer.create` 整个替换成桩，专注验证重试状态机 ——
 * 于是**没有任何用例真的执行过 wasm**。2.8.9 的 #826 正是从这个缺口进来的：
 * 它在调用后用 `__wbindgen_export4(ptr, len, 1)` 释放输入串，而该模块的入参
 * 在 Rust 侧是**按所有权接管**的，JS 再释放即双重释放，wasm 直接抛
 * `RuntimeError: unreachable`（调用栈落在 free 那一步）。
 *
 * 后果不是「偶发报错」：整个 Qoder / Qoder CN 车道的请求**在本地就 panic**，
 * combo 层只看到一句 `unreachable`，看起来像网络或额度问题，极难定位
 * （与 #669 同型：wasm panic 被摊平成 502 unreachable）。
 *
 * 实现说明：源文件带 TS 参数属性，Node 的 strip-only 模式加载不了，故先用
 * esbuild 打成临时 ESM 再导入。产物**必须写在 `vendor/channel-pack/` 下**，
 * 因为胶水用 `import.meta.url` 相对定位 `qoder-auth-wasm.wasm`。跑完即删。
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = join('vendor', 'channel-pack', '.wasm-probe.mjs')

await build({
  entryPoints: ['vendor/channel-pack/src/qoder-wasm.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'silent',
})

const user = {
  uid: 'fixture-uid',
  securityOauthToken: 'fixture-oauth-token',
  organizationTags: [],
  dataPolicyAgreed: false,
}

const ROUNDS = 8
try {
  const { generateRuntimeAuthFields } = await import(pathToFileURL(outfile).href)
  for (let round = 0; round < ROUNDS; round += 1) {
    const fields = await generateRuntimeAuthFields(user)
    assert.equal(typeof fields.encrypt_user_info, 'string', `round ${round}: encrypt_user_info must be a string`)
    assert.ok(fields.encrypt_user_info.length > 0, `round ${round}: encrypt_user_info must not be empty`)
    assert.equal(typeof fields.key, 'string', `round ${round}: key must be a string`)
    assert.ok(fields.key.length > 0, `round ${round}: key must not be empty`)
    // ⚠️ 不能断言两次结果相同：密文每次带新 nonce，本来就不同（第一版用例就错在这）。
    // 连跑多轮的意义在于**不 trap** —— 双重释放常常第二次才炸。
  }
} finally {
  rmSync(outfile, { force: true })
}

console.log(`ok  qoder wasm: generate_runtime_auth_fields runs ${ROUNDS} times without trapping (#826 regression)`)
