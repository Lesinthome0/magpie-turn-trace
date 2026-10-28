$ErrorActionPreference = "Stop"
$stopScript = Join-Path $PSScriptRoot "stop-background.ps1"
$taskName = "MagpieTurnTrace"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed Magpie Turn Trace scheduled task."
} else {
  Write-Output "Magpie Turn Trace scheduled task was not installed."
}

if (Test-Path -LiteralPath $stopScript) {
  & $stopScript
}

$startupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "MagpieTurnTrace.vbs"
Remove-Item -LiteralPath $startupLauncher -Force -ErrorAction SilentlyContinue
