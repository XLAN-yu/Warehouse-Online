@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 (
  echo.
  echo Warehouse Offline could not start. Please keep all package files together.
  pause
)
