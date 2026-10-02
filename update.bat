@echo off
rem Star Canvas / YesNAI Studio - pull the latest version from GitHub, merge, and deploy (double-click me)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node tools\update.mjs %*
echo.
pause
