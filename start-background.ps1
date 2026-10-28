param(
  [string]$NodePath = "",
  [switch]$StayAttached
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3426
$pidFile = Join-Path $root "server.pid"
$stateDir = Join-Path $env:LOCALAPPDATA "MagpieTurnTrace"
$stdoutLog = Join-Path $stateDir "server.out.log"
$stderrLog = Join-Path $stateDir "server.err.log"

function Test-TraceHealth {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
    return $health.ok -eq $true -and [int]$health.port -eq $port
  } catch {
    return $false
  }
}

if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
while ($true) {
  if (Test-TraceHealth) {
    if (-not $StayAttached) {
      exit 0
    }
    # Keep the scheduled-task action alive and become a lightweight health monitor.
    Start-Sleep -Seconds 5
    continue
  }

  $process = Start-Process `
    -FilePath $NodePath `
    -ArgumentList "server.mjs" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-TraceHealth) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    if (-not $StayAttached) {
      Write-Error "Magpie Turn Trace did not become ready. See $stderrLog"
      exit 1
    }
    Start-Sleep -Seconds 5
    continue
  }

  if (-not $StayAttached) {
    exit 0
  }

  # A scheduled task must keep its action process alive. If Node exits for any
  # reason, loop immediately and bring the loopback service back.
  $process.WaitForExit()
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
