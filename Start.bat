@echo off
setlocal
cd /d "%~dp0"
title Speaker

:: Pull latest changes if git is available
where git >nul 2>&1
if not errorlevel 1 git pull

:: Download binaries if missing
if not exist "%~dp0bin\win\node.exe" (
    echo  node.exe not found — running Download.bat first...
    echo.
    call "%~dp0Download.bat"
)

:: Use bundled binaries if present
if exist "%~dp0bin\win\node.exe"        set "PATH=%~dp0bin\win;%PATH%"
if exist "%~dp0bin\win\cloudflared.exe" set "PATH=%~dp0bin\win;%PATH%"

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Node.js not found and Download.bat failed.
    echo  Install manually from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node "%~dp0launcher.js"

echo.
pause
