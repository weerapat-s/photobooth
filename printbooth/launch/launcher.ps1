param(
  [string]$Page = "",
  [switch]$Kiosk
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-EnvValue([string]$key, [string]$fallback) {
  $envFile = Join-Path $root ".env"
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match "^\s*$key\s*=\s*([^#]*?)\s*$") {
        $v = $Matches[1]
        if ($v -ne "") { return $v }
      }
    }
  }
  return $fallback
}

$adminPort = [int](Get-EnvValue "PRINT_PORT" "4701")
$boardPort = [int](Get-EnvValue "BOARD_PORT" "4702")
$port = if ($Page -eq "/queue.html") { $boardPort } else { $adminPort }
$title = "บูทปริ้น"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "print.log"

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

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { Show-Error "ไม่พบ Node.js — ติดตั้งจาก https://nodejs.org แล้วรัน install.cmd"; exit 1 }

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules\express"))) {
  $npm = Join-Path (Split-Path $node) "npm.cmd"
  Start-Process -FilePath $npm -ArgumentList "install", "--no-fund", "--no-audit" -WorkingDirectory $root -Wait -WindowStyle Hidden
}

$serverProc = $null
if (-not (Test-Port $adminPort)) {
  $serverProc = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'index.js')`"" -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"

  $ready = $false
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 400
    if ((Test-Port $adminPort) -and (Test-Port $port)) { $ready = $true; break }
    if ($serverProc.HasExited) { break }
  }
  if (-not $ready) {
    $detail = ""
    if (Test-Path -LiteralPath "$log.err") { $detail = (Get-Content -LiteralPath "$log.err" -Tail 6) -join "`n" }
    Show-Error "เปิดบูทปริ้นไม่สำเร็จ`n`n$detail`n`nดูเพิ่มที่ $log"
    if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force }
    exit 1
  }
}

$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$url = "http://localhost:$port$Page"
$profileKey = if ($Page) { "print-board" } else { "print" }
$profileDir = Join-Path $env:LOCALAPPDATA "photobooth-kiosk\$profileKey"

if ($browser) {
  $args = @(
    "--app=$url",
    "--user-data-dir=`"$profileDir`"",
    "--no-first-run",
    "--no-default-browser-check"
  )
  if ($Kiosk) { $args += @("--start-fullscreen", "--kiosk") }
  Start-Process -FilePath $browser -ArgumentList $args -Wait
}
else {
  Start-Process $url
  exit 0
}

if ($serverProc -and -not $serverProc.HasExited) {
  Start-Sleep -Milliseconds 800
  $others = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe' or name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like "*--app=http://localhost:$adminPort*" -or
      $_.CommandLine -like "*--app=http://localhost:$boardPort*"
    })
  if ($others.Count -eq 0) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
}
