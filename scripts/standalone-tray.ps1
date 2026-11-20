<#
.SYNOPSIS
    Our Free Model Standalone Tray Runner
    托盘驻留并管理本地独立服务的生命周期
#>

param(
    [string]$Port = "18900"
)

# 强制单实例运行（避免多个托盘和进程冲突）
$mutexName = "Global\OurFreeModel_Standalone_Tray_Mutex"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Our Free Model 服务已经在运行中（可在系统托盘右下角查看）。",
        "Our Free Model",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    )
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path "$scriptDir\..").Path
$logDir = Join-Path $projectRoot "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$logFile = Join-Path $logDir "standalone.log"
$iconPath = Join-Path $projectRoot "packages\desktop\src-tauri\icons\icon.ico"

# 默认管理 URL
$script:managementUrl = "http://127.0.0.1:$Port"
$script:isManualExit = $false
# 重启窗口期：此时旧进程已退出、新进程还没起来，定时器的「异常退出」判定
# 必须让路，否则那两秒里会弹一个假的崩溃提示并把托盘整个关掉。
$script:isRestarting = $false

$errLog = Join-Path $logDir "standalone.err.log"

# 首次拉起与「重启服务」复用同一个入口：命令行、重定向、隐藏窗口三处口径
# 必须一致，否则托盘重启起来的进程和快捷方式首次拉起的不是同一个形态
# （比如漏了 RedirectStandardOutput，就再也读不到新的登录链接）。
function Start-NodeService {
    Start-Process -FilePath "node.exe" -ArgumentList "packages/standalone/cli.mjs --port $Port" -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
}

try {
    $script:process = Start-NodeService
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "启动 Node 服务失败，请确认系统已安装 Node.js 并且在环境变量 PATH 中。`n错误详情：$($_.Exception.Message)",
        "启动失败",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    exit 1
}

# 创建托盘图标
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) {
    $notifyIcon.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Text = "Our Free Model 本地服务"
$notifyIcon.Visible = $true

# 创建右键上下文菜单
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# 重启服务：按 PID 杀掉整个子进程树后原地拉起一个新的，托盘本身不退出
# （图标、菜单、单实例互斥量都保留）。等价于「退出再双击快捷方式」，
# 但少一次托盘重建，也不会撞上单实例提示。
function Restart-NodeService {
    $script:isRestarting = $true
    try {
        if ($script:process -and -not $script:process.HasExited) {
            # /T 连子进程一起杀：cli.mjs 会 spawn 渠道 worker，只杀父进程会留下孤儿。
            Start-Process "taskkill" -ArgumentList "/F /T /PID $($script:process.Id)" -WindowStyle Hidden -Wait
            try { $script:process.WaitForExit(5000) | Out-Null } catch {}
        }
        # 等旧进程真正释放 stdout/stderr 句柄（否则新进程写同一个日志文件会失败），
        # 顺便躲开端口可能的短暂 TIME_WAIT。
        Start-Sleep -Milliseconds 400
        $script:process = Start-NodeService
        # 重置成裸地址：定时器只在「还没读到登录链接」时才刷新，
        # 不重置的话新进程的新令牌永远读不进来，菜单会指向已失效的旧链接。
        $script:managementUrl = "http://127.0.0.1:$Port"
        Start-Sleep -Milliseconds 800
        if ($script:process.HasExited) {
            # 多半是端口还没放开：等两秒重试一次，仍失败才如实报错。
            Start-Sleep -Seconds 2
            $script:process = Start-NodeService
            Start-Sleep -Milliseconds 800
        }
        if ($script:process.HasExited) {
            [System.Windows.Forms.MessageBox]::Show(
                "重启后服务进程立即退出，请查看 logs/standalone.log 与 logs/standalone.err.log。",
                "重启失败",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            )
            return
        }
        $notifyIcon.BalloonTipTitle = "Our Free Model 服务已重启"
        $notifyIcon.BalloonTipText = "托盘保持运行；双击图标可打开管理面板（登录链接已刷新）。"
        $notifyIcon.ShowBalloonTip(3000)
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "重启服务失败：$($_.Exception.Message)",
            "重启失败",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    } finally {
        $script:isRestarting = $false
    }
}

$menuOpen = $contextMenu.Items.Add("打开管理面板")
$menuOpen.Font = New-Object System.Drawing.Font($menuOpen.Font, [System.Drawing.FontStyle]::Bold)
$menuOpen.add_Click({
    [System.Diagnostics.Process]::Start($script:managementUrl)
})

$menuLog = $contextMenu.Items.Add("查看运行日志")
$menuLog.add_Click({
    if (Test-Path $logFile) {
        [System.Diagnostics.Process]::Start("notepad.exe", "`"$logFile`"")
    }
})

# 重启服务（改完插件 / 合并完上游之后，用它比退出再双击快捷方式快一步）
$menuRestart = $contextMenu.Items.Add("重启服务")
$menuRestart.add_Click({
    Restart-NodeService
})

$contextMenu.Items.Add("-") | Out-Null

# 结束服务入口
$menuExit = $contextMenu.Items.Add("结束服务并退出")
$menuExit.add_Click({
    $script:isManualExit = $true
    $notifyIcon.Visible = $false
    try {
        if ($script:process -and -not $script:process.HasExited) {
            # taskkill 强行终止以该 PID 为根的整个子进程树
            Start-Process "taskkill" -ArgumentList "/F /T /PID $($script:process.Id)" -WindowStyle Hidden -Wait
        }
    } catch {}
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $contextMenu

# 双击托盘图标打开管理面板
$notifyIcon.add_DoubleClick({
    [System.Diagnostics.Process]::Start($script:managementUrl)
})

# 气泡通知
$notifyIcon.BalloonTipTitle = "Our Free Model 独立服务已启动"
$notifyIcon.BalloonTipText = "服务已在后台运行。单击或双击托盘可打开管理面板，右键托盘图标可结束服务。"
$notifyIcon.ShowBalloonTip(3000)

# 定时检查进程状态（若被异常中断则提示退出）
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
    # 重启窗口期整轮跳过：旧进程刚被杀、新进程还没起来，此时 HasExited 为真，
    # 不跳过就会误报「服务异常退出」并把托盘关掉（重启反而变成退出）。
    if ($script:isRestarting) { return }
    if ($script:managementUrl -eq "http://127.0.0.1:$Port" -and (Test-Path $logFile)) {
        try {
            $content = [System.IO.File]::ReadAllText($logFile)
            if ($content -match '(http://127\.0\.0\.1:\d+/[^\s\r\n]*)') {
                $script:managementUrl = $matches[1]
            }
        } catch {}
    }
    if ($script:process.HasExited -and -not $script:isManualExit -and -not $script:isRestarting) {
        $timer.Stop()
        $notifyIcon.Visible = $false
        [System.Windows.Forms.MessageBox]::Show(
            "Our Free Model 服务进程异常退出，详情请查阅 logs/standalone.log。",
            "服务异常",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        $notifyIcon.Dispose()
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

# 进入 WinForms 消息循环
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if (-not $script:isManualExit -and $script:process -and -not $script:process.HasExited) {
        Start-Process "taskkill" -ArgumentList "/F /T /PID $($script:process.Id)" -WindowStyle Hidden -Wait
    }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
