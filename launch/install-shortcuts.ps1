param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path -Parent $here

$targets = @(
  @{ Name = "Photo Booth"; Vbs = "booth.vbs"; Icon = "booth.ico"; Desc = "จอลูกค้า — เต็มจอ" },
  @{ Name = "จอช่าง"; Vbs = "operator.vbs"; Icon = "operator.ico"; Desc = "จอช่าง — คุมเซสชันและตั้งค่า" }
)

$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Photo Booth"
$startup = [Environment]::GetFolderPath("Startup")
$bridgeStartup = Join-Path $startup "Photo Booth Bridge.lnk"
$watchdogTaskName = "Photo Booth Bridge Watchdog"

if ($Uninstall) {
  foreach ($t in $targets) {
    Remove-Item -LiteralPath (Join-Path $desktop "$($t.Name).lnk") -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $bridgeStartup -ErrorAction SilentlyContinue
  & schtasks.exe /Delete /TN $watchdogTaskName /F 2>$null | Out-Null
  Write-Output "ลบ shortcut แล้ว"
  return
}

# สร้างไอคอนถ้ายังไม่มี
$iconDir = Join-Path $root "assets\icons"
if (-not (Test-Path -LiteralPath (Join-Path $iconDir "booth.ico"))) {
  # ตัวที่มากับชุดติดตั้งมาก่อน เครื่องที่ไม่เคยลง Node.js จะได้มีไอคอนเหมือนกัน
  $node = $null
  $bundledNode = Join-Path $root "runtime\node.exe"
  if (Test-Path -LiteralPath $bundledNode) { $node = $bundledNode }
  if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if ($node) {
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $here 'make-icons.js')`"" -WorkingDirectory $root -Wait -WindowStyle Hidden
  }
}

New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$shell = New-Object -ComObject WScript.Shell

foreach ($t in $targets) {
  foreach ($dir in @($desktop, $startMenu)) {
    $lnkPath = Join-Path $dir "$($t.Name).lnk"
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
    $lnk.Arguments = "`"$(Join-Path $here $t.Vbs)`""
    $lnk.WorkingDirectory = $root
    $lnk.Description = $t.Desc
    $icon = Join-Path $iconDir $t.Icon
    if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    Write-Output "สร้าง $lnkPath"
  }
}

# เปิด Windows bridge อัตโนมัติหลังล็อกอิน เพื่อให้ iPad เข้าเว็บได้โดยไม่ต้องเปิด terminal
$bridge = $shell.CreateShortcut($bridgeStartup)
$bridge.TargetPath = "$env:WINDIR\System32\wscript.exe"
$bridge.Arguments = "`"$(Join-Path $here 'bridge.vbs')`""
$bridge.WorkingDirectory = $root
$bridge.Description = "เปิด Photo Booth backend สำหรับ iPad อัตโนมัติ"
$bridgeIcon = Join-Path $iconDir "booth.ico"
if (Test-Path -LiteralPath $bridgeIcon) { $bridge.IconLocation = "$bridgeIcon,0" }
$bridge.Save()
Write-Output "สร้าง $bridgeStartup"

# ตรวจทุก 1 นาที ถ้า backend หรือ Cloudflare Tunnel หยุด bridge.vbs จะเปิดกลับโดยกันโปรเซสซ้ำไว้แล้ว
$watchdogCommand = '"' + "$env:WINDIR\System32\wscript.exe" + '" "' + (Join-Path $here 'bridge.vbs') + '"'
& schtasks.exe /Create /TN $watchdogTaskName /TR $watchdogCommand /SC MINUTE /MO 1 /F | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Output "สร้าง Scheduled Task: $watchdogTaskName" }
