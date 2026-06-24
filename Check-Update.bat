@echo off
cd /d "%~dp0"

echo.
echo  Speaker -- Update Check
echo  ========================
echo.

:: Get local commit
for /f %%i in ('git rev-parse HEAD 2^>nul') do set LOCAL=%%i
if "%LOCAL%"=="" (
    echo  [!] Could not read local commit. Is git installed?
    echo.
    pause
    exit /b 1
)

:: Get remote commit SHA (uses existing git credentials, works with private repos)
echo  Checking GitHub...
for /f %%i in ('git ls-remote origin refs/heads/main 2^>nul') do set REMOTE=%%i

if "%REMOTE%"=="" (
    echo  [!] Could not reach the remote repository.
    echo      Check your internet connection.
    echo.
    pause
    exit /b 1
)

echo  Local  : %LOCAL%
echo  Remote : %REMOTE%
echo.

if /i "%LOCAL%"=="%REMOTE%" (
    echo  [OK] You are up to date.
) else (
    echo  [!!] Your copy is OUTDATED.
    echo.
    echo  To update, open a terminal in this folder and run:
    echo.
    echo    git pull
)

echo.
pause
