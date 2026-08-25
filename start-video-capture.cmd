@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

echo [Video Knowledge Capture] Starting local capture desk...
node src\launcher.mjs %*
if errorlevel 1 goto launch_failed
exit /b 0

:node_missing
echo [Video Knowledge Capture] Node.js 20 or newer is required.
if not "%VKC_NO_PAUSE%"=="1" pause
exit /b 1

:launch_failed
echo.
echo [Video Knowledge Capture] Startup failed. See the message above.
if not "%VKC_NO_PAUSE%"=="1" pause
exit /b 1
