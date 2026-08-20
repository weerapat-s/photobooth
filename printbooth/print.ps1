param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [int]$Copies = 1,
  [string]$PrinterName = "",
  [string]$Paper = "4x6",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $ImagePath)) { throw "ไม่พบไฟล์: $ImagePath" }

$image = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.DocumentName = "PhotoBooth " + [System.IO.Path]::GetFileNameWithoutExtension($ImagePath)

if ($PrinterName -ne "") { $doc.PrinterSettings.PrinterName = $PrinterName }
if (-not $doc.PrinterSettings.IsValid) { throw "เครื่องพิมพ์ใช้ไม่ได้: $($doc.PrinterSettings.PrinterName)" }

$doc.PrinterSettings.Copies = [int]$Copies

# เลือกขนาดกระดาษที่ตรงกับ -Paper (เทียบเป็นนิ้ว) ถ้าไม่เจอ ใช้ค่าเริ่มต้นของไดรเวอร์
$target = switch ($Paper) {
  "4x6" { @(4.0, 6.0) }
  "6x4" { @(6.0, 4.0) }
  "2x6" { @(2.0, 6.0) }
  "5x7" { @(5.0, 7.0) }
  default { $null }
}
if ($target) {
  foreach ($size in $doc.PrinterSettings.PaperSizes) {
    $w = $size.Width / 100.0
    $h = $size.Height / 100.0
    $matchDirect = ([math]::Abs($w - $target[0]) -lt 0.15) -and ([math]::Abs($h - $target[1]) -lt 0.15)
    $matchRotated = ([math]::Abs($h - $target[0]) -lt 0.15) -and ([math]::Abs($w - $target[1]) -lt 0.15)
    if ($matchDirect -or $matchRotated) {
      $doc.DefaultPageSettings.PaperSize = $size
      break
    }
  }
}

# พิมพ์เต็มขอบ ไม่เว้นขอบขาว
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.OriginAtMargins = $false

$pageW = $doc.DefaultPageSettings.PaperSize.Width
$pageH = $doc.DefaultPageSettings.PaperSize.Height
$doc.DefaultPageSettings.Landscape = ($image.Width -gt $image.Height) -and ($pageW -lt $pageH)

$printHandler = {
  param($sender, $e)
  $bounds = $e.PageBounds
  $iw = $image.Width
  $ih = $image.Height
  # หมุนภาพให้แนวเดียวกับกระดาษ กันภาพเล็กลงเพราะวางผิดแนว
  if ((($iw -gt $ih) -and ($bounds.Width -lt $bounds.Height)) -or (($iw -lt $ih) -and ($bounds.Width -gt $bounds.Height))) {
    $image.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
    $iw = $image.Width
    $ih = $image.Height
  }
  # scale แบบ cover เพื่อเต็มกระดาษ ส่วนเกินถูกตัด (photo print มาตรฐาน)
  $scale = [math]::Max($bounds.Width / $iw, $bounds.Height / $ih)
  $dw = [int]($iw * $scale)
  $dh = [int]($ih * $scale)
  $dx = $bounds.X + [int](($bounds.Width - $dw) / 2)
  $dy = $bounds.Y + [int](($bounds.Height - $dh) / 2)
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.DrawImage($image, $dx, $dy, $dw, $dh)
  $e.HasMorePages = $false
}

$doc.add_PrintPage($printHandler)

try {
  if ($DryRun) {
    Write-Output "dry-run: printer='$($doc.PrinterSettings.PrinterName)' paper=$($doc.DefaultPageSettings.PaperSize.PaperName) ($($doc.DefaultPageSettings.PaperSize.Width/100)x$($doc.DefaultPageSettings.PaperSize.Height/100) in) image=$($image.Width)x$($image.Height) copies=$Copies"
    return
  }
  $doc.Print()
  Write-Output "printed to '$($doc.PrinterSettings.PrinterName)' paper=$($doc.DefaultPageSettings.PaperSize.PaperName) copies=$Copies"
}
finally {
  $doc.Dispose()
  $image.Dispose()
}
