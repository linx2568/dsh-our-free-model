' Our Free Model 托盘启动器（无黑框静默启动）
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectRoot

psScript = scriptDir & "\standalone-tray.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
shell.Run cmd, 0, False
