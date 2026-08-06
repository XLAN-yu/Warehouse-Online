@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-warehouse-package.ps1"
if errorlevel 1 (
  echo.
  echo 生成失败，请查看上方提示。
  pause
  exit /b 1
)
echo.
echo 已自动删除旧压缩包并生成最新离线包。
pause
