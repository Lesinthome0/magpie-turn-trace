$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $root "start-background.ps1"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskName = "MagpieTurnTrace"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NodePath `"$nodePath`" -StayAttached"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# The old Startup-folder launcher would start a second copy alongside the task.
$startupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "MagpieTurnTrace.vbs"
Remove-Item -LiteralPath $startupLauncher -Force -ErrorAction SilentlyContinue

Start-ScheduledTask -TaskName $taskName
Write-Output "Installed Magpie Turn Trace as scheduled task: $taskName"
