#Requires -Version 5.1
<#
  ตัวติดตั้ง Photo Booth — ทำงานจากโฟลเดอร์ที่ PhotoBoothSetup.exe แตกไฟล์ออกมา

  ไม่ต้องมีอะไรติดตั้งไว้ก่อน: Node.js กับ dependency ทั้งหมดมาในชุดแล้ว
  อย่างเดียวที่ต้องโหลดจากเน็ตคือ digiCamControl (ตัวคุมกล้อง) และเฉพาะตอนที่ยังไม่มี
#>
param(
  [string]$Source = $PSScriptRoot,
  [string]$Target = "$env:LOCALAPPDATA\PhotoBooth",
  [switch]$SkipCamera,
  [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$warnings = New-Object System.Collections.Generic.List[string]

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "   $text" -ForegroundColor Green }
function Info([string]$text) { Write-Host "   $text" }
function Warn([string]$text) { $warnings.Add($text); Write-Host "   ! $text" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  Photo Booth — KMITL EXPO 2026' -ForegroundColor Cyan
Write-Host "  ติดตั้งลงที่ $Target"
Write-Host ''

# ── 1. ปิดของเดิมที่ยังรันอยู่ ────────────────────────────────────────────────
Step 'ตรวจของเดิม'
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Target, 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  Ok "ปิด Photo Booth ที่รันอยู่ $($running.Count) โปรเซส"
} elseif (Test-Path -LiteralPath $Target) {
  Ok 'พบตัวเดิม จะอัปเดตทับ (ตั้งค่าและรูปเก่าไม่หาย)'
} else {
  Ok 'ติดตั้งใหม่'
}

# ── 2. คัดลอกไฟล์โปรแกรม ─────────────────────────────────────────────────────
Step 'คัดลอกไฟล์โปรแกรม'
New-Item -ItemType Directory -Path $Target -Force | Out-Null
$appSource = Join-Path $Source 'app'
if (-not (Test-Path -LiteralPath $appSource)) { throw "ชุดติดตั้งไม่ครบ: ไม่พบโฟลเดอร์ app ใน $Source" }

# /MIR ล้างไฟล์เก่าที่ไม่มีในเวอร์ชันใหม่ แต่ต้องกัน .env, รูปที่ถ่ายไว้ และ log ไม่ให้โดนลบ
$robo = & robocopy.exe $appSource $Target /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 /XF '.env' /XD 'sessions' 'logs'
if ($LASTEXITCODE -ge 8) { throw "คัดลอกไฟล์ไม่สำเร็จ (robocopy exit $LASTEXITCODE)" }
$global:LASTEXITCODE = 0
Ok 'คัดลอกไฟล์โปรแกรมและ dependency ครบ'

foreach ($dir in @('logs', 'sessions')) {
  New-Item -ItemType Directory -Path (Join-Path $Target $dir) -Force | Out-Null
}

# ── 3. Node.js ที่มากับชุด ───────────────────────────────────────────────────
Step 'Node.js'
$node = Join-Path $Target 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw "ชุดติดตั้งไม่ครบ: ไม่พบ runtime\node.exe" }
$nodeVersion = (& $node -v).Trim()
Ok "ใช้ Node.js ที่มากับชุด ($nodeVersion) ไม่ต้องติดตั้งเพิ่ม"

# ── 4. ตั้งค่า ───────────────────────────────────────────────────────────────
Step 'ตั้งค่า'
$envFile = Join-Path $Target '.env'
if (Test-Path -LiteralPath $envFile) {
  Ok 'มี .env เดิมอยู่แล้ว เก็บไว้ตามเดิม'
} else {
  $template = Join-Path $Source 'env.template'
  if (-not (Test-Path -LiteralPath $template)) { throw "ชุดติดตั้งไม่ครบ: ไม่พบ env.template" }
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $template -Encoding UTF8)

  # โทเคนของ iPad ต้องไม่ซ้ำกันระหว่างเครื่อง จึงสุ่มใหม่ทุกครั้งที่ติดตั้งสด
  $bytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

  # ชื่อบูทตั้งตามชื่อเครื่อง เพื่อให้แยกออกว่าคิวไหนมาจากเครื่องไหน
  $booth = ($env:COMPUTERNAME -replace '[^A-Za-z0-9]', '-').ToLower()
  if (-not $booth) { $booth = 'booth-1' }

  $patch = @{ IPAD_API_TOKEN = $token; BOOTH_NAME = $booth }
  foreach ($name in $patch.Keys) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match ('^' + [regex]::Escape($name) + '=')) { $lines[$i] = "$name=$($patch[$name])"; $found = $true; break }
    }
    if (-not $found) { $lines.Add("$name=$($patch[$name])") }
  }
  Set-Content -LiteralPath $envFile -Value $lines -Encoding UTF8
  Ok "สร้าง .env ใหม่ (ชื่อบูท $booth, โทเคน iPad สุ่มใหม่)"
}

$captureDir = 'C:\photobooth-captures'
try {
  New-Item -ItemType Directory -Path $captureDir -Force | Out-Null
  Ok "โฟลเดอร์รับภาพจากกล้อง $captureDir"
} catch {
  Warn "สร้าง $captureDir ไม่ได้ — เปิดหน้าจอช่างแล้วแก้ CAPTURE_DIR เป็นที่อื่น"
}

# ── 5. digiCamControl (ตัวคุมกล้อง) ──────────────────────────────────────────
Step 'digiCamControl (ตัวคุมกล้อง)'
$dccExe = 'C:\Program Files (x86)\digiCamControl\CameraControl.exe'
if (Test-Path -LiteralPath $dccExe) {
  $dccVersion = (Get-Item -LiteralPath $dccExe).VersionInfo.FileVersion
  Ok "มีอยู่แล้ว ($dccVersion)"
} elseif ($SkipCamera) {
  Warn 'ข้ามการติดตั้ง digiCamControl ตามที่สั่ง — ยังถ่ายด้วยกล้องจริงไม่ได้'
} else {
  Info 'ยังไม่มี กำลังดาวน์โหลดจากเว็บทางการ (ประมาณ 70-90 MB)...'
  $installer = Join-Path $env:TEMP ('digiCamControlSetup-' + [guid]::NewGuid().ToString('N') + '.exe')
  $sources = @(
    'https://sourceforge.net/projects/digicamcontrol/files/digiCamControlsetup_2.1.7.0.exe/download',
    'https://github.com/dukus/digiCamControl/releases/download/2.0.26/digiCamControlsetup_2.0.26.0.exe'
  )
  $got = $false
  foreach ($url in $sources) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 600 -ErrorAction Stop
      if ((Get-Item -LiteralPath $installer).Length -gt 10MB) { $got = $true; break }
    } catch {
      Info "โหลดจาก $($url.Split('/')[2]) ไม่สำเร็จ ลองแหล่งถัดไป"
    }
  }
  if ($got) {
    Info 'กำลังติดตั้ง (Windows จะถามสิทธิ์ผู้ดูแล — กดยืนยัน)'
    try {
      $proc = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
      if ((Test-Path -LiteralPath $dccExe)) { Ok 'ติดตั้ง digiCamControl เรียบร้อย' }
      else { Warn "ตัวติดตั้ง digiCamControl จบด้วยรหัส $($proc.ExitCode) แต่ยังไม่พบโปรแกรม — ติดตั้งเองจาก digicamcontrol.com" }
    } catch {
      Warn "สั่งติดตั้ง digiCamControl ไม่สำเร็จ: $($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
  } else {
    Warn 'ดาวน์โหลด digiCamControl ไม่สำเร็จ — ติดตั้งเองจาก digicamcontrol.com แล้วรีสตาร์ต Windows'
  }
}

$ffmpeg = 'C:\Program Files (x86)\digiCamControl\ffmpeg.exe'
if (Test-Path -LiteralPath $ffmpeg) {
  Ok 'มี ffmpeg สำหรับทำวิดีโอ (มากับ digiCamControl)'
} else {
  Warn 'ไม่พบ ffmpeg — การ์ดกับ QR ยังทำงาน แต่วิดีโอจะไม่ออก ต้องติดตั้ง digiCamControl ให้ได้ก่อน'
}

# ── 6. ไอคอนและช็อตคัต ───────────────────────────────────────────────────────
Step 'ไอคอนและช็อตคัต'
if ($SkipShortcuts) {
  Info 'ข้ามตามที่สั่ง'
} else {
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'launch\install-shortcuts.ps1') | ForEach-Object { Info $_ }
  if ($LASTEXITCODE -ne 0) { throw "install-shortcuts.ps1 exit $LASTEXITCODE" }
  Ok 'สร้างช็อตคัตหน้าจอ + เปิดอัตโนมัติตอนล็อกอินแล้ว'
} catch {
  Warn "สร้างช็อตคัตไม่สำเร็จ: $($_.Exception.Message)"
}
}

# ── 7. ตรวจการเชื่อมต่อ NAS ──────────────────────────────────────────────────
Step 'เชื่อมต่อ NAS'
$check = Join-Path $Target 'launch\verify-install.mjs'
$report = $null
try {
  # ต้องรันโดยมี working directory เป็นที่ติดตั้ง เพราะ dotenv อ่าน .env จาก cwd
  Push-Location -LiteralPath $Target
  try { $raw = & $node $check 2>&1 | Out-String } finally { Pop-Location }
  $report = $raw.Trim() | ConvertFrom-Json
} catch {
  Warn "ตรวจการเชื่อมต่อไม่สำเร็จ: $($_.Exception.Message)"
}
if ($report) {
  if ($report.share.ok) { Ok "อัปโหลดขึ้น NAS ได้ ($($report.share.base))" }
  else { Warn "ต่อ NAS ไม่ได้: $($report.share.error) — เปิดหน้าจอช่างแล้วแก้ค่า NC_*" }
  if ($report.owner.ok) { Ok 'บัญชี Nextcloud ใช้ได้ — QR จะแยกลิงก์ให้ลูกค้าแต่ละคน' }
  else { Warn "บัญชี Nextcloud ใช้ไม่ได้: $($report.owner.error) — QR จะยังทำงาน แต่ลูกค้าจะเห็นโฟลเดอร์รวม" }
  if ($report.template.ok) { Ok "เทมเพลตการ์ด $($report.template.slots) ช่อง ($($report.template.size))" }
  else { Warn "เทมเพลตการ์ดมีปัญหา: $($report.template.error)" }
}

# ── สรุป ─────────────────────────────────────────────────────────────────────
Write-Host ''
if ($warnings.Count -eq 0) {
  Write-Host '  ติดตั้งเสร็จ พร้อมใช้งาน' -ForegroundColor Green
} else {
  Write-Host "  ติดตั้งเสร็จ แต่มี $($warnings.Count) เรื่องต้องดู" -ForegroundColor Yellow
  foreach ($w in $warnings) { Write-Host "   - $w" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  ต่อไป:'
Write-Host '   1. เสียบกล้องเข้าคอมด้วยสาย USB แล้วเปิดกล้อง'
Write-Host '   2. ดับเบิลคลิก "Photo Booth" บนหน้าจอ (จอลูกค้า)'
Write-Host '   3. "จอช่าง" ไว้คุมเซสชันและแก้ค่า'
Write-Host ''
Write-Host '  ลูกค้าสแกน QR แล้วได้ลิงก์ของตัวเองบน NAS ทันที ไม่ต้องตั้งอะไรเพิ่ม'
Write-Host ''
exit 0
