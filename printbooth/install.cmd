@echo off
setlocal
cd /d "%~dp0"

echo === ติดตั้งบูทปริ้น ===

where node >nul 2>nul
if errorlevel 1 (
  echo [X] ไม่พบ Node.js - ติดตั้งจาก https://nodejs.org ก่อน แล้วรันไฟล์นี้ใหม่
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [+] สร้างไฟล์ .env แล้ว - ต้องกรอก PRINTER_ID, PRINTER_NAME และค่า Nextcloud
)

echo [*] ติดตั้ง dependency...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo [X] npm install ไม่ผ่าน
  pause
  exit /b 1
)

echo [*] สร้างไอคอนบนเดสก์ท็อป...
powershell -NoProfile -ExecutionPolicy Bypass -File "launch\install-shortcuts.ps1"

echo.
echo === เสร็จแล้ว ===
echo แก้ไฟล์ .env ให้ PRINTER_ID ไม่ซ้ำ พร้อมกรอก NC_SHARE_TOKEN/NC_SHARE_PASSWORD แล้วเปิดไอคอน "บูทปริ้น"
notepad .env
pause
