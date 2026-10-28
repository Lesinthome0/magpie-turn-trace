@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org/ and rerun this file.
  pause
  exit /b 1
)
echo Starting Magpie Turn Trace on http://127.0.0.1:3426/
echo Keep this window open while using the sidebar page.
node server.mjs
pause
