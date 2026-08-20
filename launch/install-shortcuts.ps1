param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path -Parent $here

$targets = @(
  @{ Name = "Photo Booth"; Vbs = "booth.vbs"; Icon = "booth.ico"; Desc = "จอลูกค้า — เต็มจอ" },
  @{ Name = "จอช่าง"; Vbs = "operator.vbs"; Icon = "operator.ico"; Desc = "จอช่าง — คุมเซสชันและตั้งค่า" },
  @{ Name = "บูทปริ้น"; Vbs = "print-booth.vbs"; Icon = "print.ico"; Desc = "เปิดบูทปริ้นรูป" }
)

$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Photo Booth"

if ($Uninstall) {
  foreach ($t in $targets) {
    Remove-Item -LiteralPath (Join-Path $desktop "$($t.Name).lnk") -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "ลบ shortcut แล้ว"
  return
}

# สร้างไอคอนถ้ายังไม่มี
$iconDir = Join-Path $root "assets\icons"
if (-not (Test-Path -LiteralPath (Join-Path $iconDir "booth.ico"))) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
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
