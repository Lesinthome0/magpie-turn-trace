$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3426
$pidFile = Join-Path $root "server.pid"
$taskName = "MagpieTurnTrace"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Write-Output "Stopped scheduled task: $taskName"
}

$processId = $null
if (Test-Path -LiteralPath $pidFile) {
  $processId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
}

if (-not $processId) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -First 1
  if ($listener) {
    $processId = [int]$listener.OwningProcess
  }
}

if ($processId) {
  Stop-Process -Id $processId -Force
  Write-Output "Stopped Magpie Turn Trace (PID $processId)."
} else {
  Write-Output "Magpie Turn Trace is not running."
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
