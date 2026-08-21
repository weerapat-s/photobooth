@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
  echo Installation failed. Read the message above, then run INSTALL.cmd again.
) else (
  echo Installation completed.
)
pause
exit /b %EXIT_CODE%
