param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path -Parent $here

$targets = @(
  @{ Name = "บูทปริ้น"; Vbs = "print-booth.vbs"; Desc = "หน้าคอนโซลช่าง — ดูคิว สั่งพิมพ์ ตั้งค่า" },
  @{ Name = "คิวปริ้น"; Vbs = "queue-board.vbs"; Desc = "จอบอร์ดคิวเต็มจอ — โชว์เลขคิวที่กำลังพิมพ์" }
)

$desktop = [Environment]::GetFolderPath("Desktop")

if ($Uninstall) {
  foreach ($t in $targets) {
    Remove-Item -LiteralPath (Join-Path $desktop "$($t.Name).lnk") -ErrorAction SilentlyContinue
  }
  Write-Output "ลบ shortcut แล้ว"
  return
}

$icon = Join-Path $root "print.ico"
$shell = New-Object -ComObject WScript.Shell

foreach ($t in $targets) {
  $lnkPath = Join-Path $desktop "$($t.Name).lnk"
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$(Join-Path $here $t.Vbs)`""
  $lnk.WorkingDirectory = $root
  $lnk.Description = $t.Desc
  if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  Write-Output "สร้าง $lnkPath"
}
