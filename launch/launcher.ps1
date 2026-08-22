param(
  [ValidateSet("booth", "operator", "bridge")][string]$Mode = "booth"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# โหลดพอร์ตจาก .env (ถ้ามี) ไม่งั้นใช้ค่าเริ่มต้น
function Get-EnvValue([string]$key, [string]$fallback) {
  $envFile = Join-Path $root ".env"
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match "^\s*$key\s*=\s*(.*?)\s*$") {
        $v = $Matches[1]
        if ($v -ne "") { return $v }
      }
    }
  }
  return $fallback
}

$page = ""
$headless = $false
if ($Mode -eq "booth") {
  $script = Join-Path $root "server\index.js"
  $port = [int](Get-EnvValue "PORT" "4700")
  $boothMonitor = [int](Get-EnvValue "BOOTH_MONITOR" "2")
  $title = "Photo Booth"
  $kiosk = $true
}
elseif ($Mode -eq "operator") {
  $script = Join-Path $root "server\index.js"
  $port = [int](Get-EnvValue "PORT" "4700")
  $title = "จอช่าง"
  $kiosk = $false
  $page = "/operator.html"
}
else {
  $script = Join-Path $root "server\index.js"
  $port = [int](Get-EnvValue "PORT" "4700")
  $title = "Photo Booth Bridge"
  $kiosk = $false
  $headless = $true
}

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "$Mode.log"

function Test-Port([int]$p) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $wait = $client.BeginConnect("127.0.0.1", $p, $null, $null)
    $ok = $wait.AsyncWaitHandle.WaitOne(300)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close()
  }
  catch { }
  return $false
}

function Show-Error([string]$text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, $title, "OK", "Error") | Out-Null
}

# หา node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { Show-Error "ไม่พบ Node.js — ติดตั้งจาก https://nodejs.org แล้วเปิดใหม่"; exit 1 }

# ถ้ายังไม่เคย npm install
if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules\express"))) {
  $npm = Join-Path (Split-Path $node) "npm.cmd"
  Start-Process -FilePath $npm -ArgumentList "install", "--no-fund", "--no-audit" -WorkingDirectory $root -Wait -WindowStyle Hidden
}

# เซิร์ฟเวอร์รันอยู่แล้วหรือยัง — ถ้ารันอยู่ก็แค่เปิดหน้าจอซ้ำ ไม่ต้องสตาร์ทซ้ำ
$serverProc = $null
if (-not (Test-Port $port)) {
  $serverProc = Start-Process -FilePath $node -ArgumentList "`"$script`"" -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"

  $ready = $false
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 400
    if (Test-Port $port) { $ready = $true; break }
    if ($serverProc.HasExited) { break }
  }
  if (-not $ready) {
    $detail = ""
    if (Test-Path -LiteralPath "$log.err") { $detail = (Get-Content -LiteralPath "$log.err" -Tail 6) -join "`n" }
    Show-Error "เปิดเซิร์ฟเวอร์ไม่สำเร็จ`n`n$detail`n`nดูเพิ่มที่ $log"
    if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force }
    exit 1
  }
}

# โหมด bridge ใช้เปิด backend ตอนล็อกอิน Windows โดยไม่เปิดหน้าต่างบนจอ
if ($headless) { exit 0 }

# หาเบราว์เซอร์ที่เปิดแบบ app window ได้
$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$url = "http://localhost:$port$page"
$profileDir = Join-Path $env:LOCALAPPDATA "photobooth-kiosk\$Mode"
$windowProcess = $null

if ($browser) {
  $args = @(
    "--app=$url",
    "--new-window",
    "--user-data-dir=`"$profileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,TranslateUI",
    "--autoplay-policy=no-user-gesture-required"
  )
  if ($kiosk) {
    # Chromium เลือกจอจากตำแหน่งหน้าต่างก่อนเข้าสู่ kiosk mode
    # BOOTH_MONITOR นับจาก 1; ถ้าหาจอที่ระบุไม่เจอจะใช้จอหลักอย่างปลอดภัย
    Add-Type -AssemblyName System.Windows.Forms
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    $screenIndex = $boothMonitor - 1
    if ($screenIndex -lt 0 -or $screenIndex -ge $screens.Count) {
      $targetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
    }
    else {
      $targetScreen = $screens[$screenIndex]
    }
    $bounds = $targetScreen.Bounds
    $args += @(
      "--window-position=$($bounds.X),$($bounds.Y)",
      "--window-size=$($bounds.Width),$($bounds.Height)",
      "--start-fullscreen",
      "--kiosk"
    )
  }
  $browserProc = Start-Process -FilePath $browser -ArgumentList $args -PassThru

  if ($kiosk) {
    # Edge บางรุ่นไม่ทำตาม --window-position เมื่อใช้ --kiosk จึงย้าย native window ซ้ำหลังเปิด
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PhotoboothWindowNative {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(
    IntPtr hWnd, IntPtr hWndInsertAfter,
    int X, int Y, int cx, int cy, uint uFlags);
}
"@

    $profilePattern = "*photobooth-kiosk\booth*"
    foreach ($i in 1..50) {
      Start-Sleep -Milliseconds 200
      $candidateIds = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe' or name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like $profilePattern } |
        Select-Object -ExpandProperty ProcessId)

      foreach ($candidateId in $candidateIds) {
        $candidate = Get-Process -Id $candidateId -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.MainWindowHandle -ne 0) {
          $moved = [PhotoboothWindowNative]::SetWindowPos(
            $candidate.MainWindowHandle, [IntPtr]::Zero,
            $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, 0x0040)
          if ($moved) {
            $windowProcess = $candidate
            break
          }
        }
      }
      if ($windowProcess) { break }
    }
  }

  if (-not $windowProcess) { $windowProcess = $browserProc }
  Wait-Process -Id $windowProcess.Id -ErrorAction SilentlyContinue
}
else {
  Start-Process $url
  # ไม่มีเบราว์เซอร์แบบ app window — ปล่อยเซิร์ฟเวอร์รันต่อ ไม่ต้องรอปิด
  exit 0
}

# ปิดหน้าจอ = ปิดเซิร์ฟเวอร์ที่ launcher นี้เปิดมาเอง
# ยกเว้นยังมีหน้าต่างอื่นเปิดพอร์ตเดียวกันอยู่ (เช่นจอลูกค้ากับจอช่างใช้เซิร์ฟเวอร์ตัวเดียวกัน)
if ($serverProc -and -not $serverProc.HasExited) {
  Start-Sleep -Milliseconds 800
  $others = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe' or name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*--app=http://localhost:$port*" })
  if ($others.Count -eq 0) {
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
  }
}
