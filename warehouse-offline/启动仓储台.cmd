@echo off
setlocal
cd /d "%~dp0"

set "PSVER="
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.Major" 2^>nul`) do set "PSVER=%%V"
if not defined PSVER goto :needPowerShell
if %PSVER% LSS 3 goto :needPowerShell

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 (
  echo.
  echo Warehouse Offline could not start.
  echo Please keep all package files together and use Chrome, Edge or Firefox instead of Internet Explorer.
  pause
)
goto :end

:needPowerShell
echo.
echo This offline warehouse requires Windows PowerShell 3.0 or later.
echo Windows 7 usually includes PowerShell 2.0, which cannot run the local data service.
echo Install Windows Management Framework 3.0 or use a newer Windows computer, then try again.
echo It also requires a modern browser such as Chrome, Edge or Firefox. Internet Explorer is not supported.
pause

:end
endlocal
