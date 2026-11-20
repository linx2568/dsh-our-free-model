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

$errLog = Join-Path $logDir "standalone.err.log"

try {
    $script:process = Start-Process -FilePath "node.exe" -ArgumentList "packages/standalone/cli.mjs --port $Port" -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
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
    if ($script:managementUrl -eq "http://127.0.0.1:$Port" -and (Test-Path $logFile)) {
        try {
            $content = [System.IO.File]::ReadAllText($logFile)
            if ($content -match '(http://127\.0\.0\.1:\d+/[^\s\r\n]*)') {
                $script:managementUrl = $matches[1]
            }
        } catch {}
    }
    if ($script:process.HasExited -and -not $script:isManualExit) {
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
