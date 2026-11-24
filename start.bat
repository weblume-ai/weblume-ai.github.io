@echo off
title Phainora AI
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
echo.
echo   Phainora AI is starting... the window will open by itself.
echo   Keep this window open. Close it to stop.
echo.
if not exist "node_modules\playwright-core\package.json" call npm install --omit=dev --no-audit --no-fund
rem One site: Weblume AI + the company (team, factory). Start the company's server too, in its own window, unless it already runs.
if exist "..\weblume-company\start.bat" (
  netstat -ano | find ":8501 " | find "LISTENING" >nul || start "Weblume Company" /min /d "%~dp0..\weblume-company" cmd /c "set NO_BROWSER=1&& call start.bat"
)
rem Jarvis listener: two claps or "Hey Jarvis" opens Jarvis (the mic is analysed on this laptop only). Set up once with desktop\setup_jarvis.bat
if exist "desktop\.venv\Scripts\pythonw.exe" start "" "desktop\.venv\Scripts\pythonw.exe" "desktop\jarvis_listener.py"
set OPEN_BROWSER=1
rem the desktop shortcuts pass "app" and an optional page ("/?jarvis") to open as an app window
if /i "%~1"=="app" (set APP_WINDOW=1& set "APP_PATH=%~2")
node "server\proxy.js"
echo.
echo   The server stopped. Read the message above.
pause
goto :eof
:nonode
echo.
echo   Node.js is not installed.
echo   Download the LTS version from nodejs.org, install it, then run start.bat again.
echo.
start "" "https://nodejs.org/"
pause
