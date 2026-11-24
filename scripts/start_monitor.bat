@echo off
REM Starts the WTNPS Fin monitor in the background and opens /monitor.
REM Usage: scripts\start_monitor.bat

setlocal
set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_background.ps1" %*
endlocal
