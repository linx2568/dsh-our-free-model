<#
.SYNOPSIS
    在桌面创建 Our Free Model 本地独立服务的快捷方式
#>

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path "$scriptDir\..").Path
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath "Our Free Model.lnk"
$vbsPath = Join-Path $scriptDir "standalone-tray.vbs"
$iconPath = Join-Path $projectRoot "packages\desktop\src-tauri\icons\icon.ico"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $projectRoot
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Description = "Our Free Model 本地独立服务（托盘运行）"
$shortcut.Save()

Write-Host "✅ 桌面快捷方式创建成功：" -ForegroundColor Green
Write-Host "   路径: $shortcutPath" -ForegroundColor Cyan
Write-Host "   双击该快捷方式即可在后台启动服务并在系统托盘显示图标。" -ForegroundColor Gray
