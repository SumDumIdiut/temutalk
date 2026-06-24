@echo off
cd /d "%~dp0"
echo.
echo  Speaker -- Download portable binaries
echo  =======================================
echo.

if not exist "bin\win" md "bin\win"

where curl >nul 2>&1
if errorlevel 1 (
    echo  curl not found. It is built into Windows 10+.
    echo  Alternatively, install Node.js and cloudflared manually
    echo  and place node.exe + cloudflared.exe in bin\win\
    echo.
    pause
    exit /b 1
)

echo [1/2] Downloading Node.js (portable, ~12 MB)...
curl.exe -L -o "bin\win\node.exe" "https://nodejs.org/dist/latest-v20.x/win-x64/node.exe"
if errorlevel 1 ( echo  FAILED. ) else ( echo  Done. )

echo.
echo [2/2] Downloading cloudflared...
curl.exe -L -o "bin\win\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
if errorlevel 1 ( echo  FAILED. ) else ( echo  Done. )

echo.
echo  Unblocking binaries...
powershell -Command "Get-ChildItem 'bin\win\*.exe' | Unblock-File" >nul 2>&1
echo  Done.

echo.
echo  Finished. Run Start.bat to launch Speaker.
echo.
pause
