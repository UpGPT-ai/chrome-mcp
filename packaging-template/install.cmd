@echo off
REM Double-click to install. Runs install.ps1 without being blocked by PowerShell's execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
