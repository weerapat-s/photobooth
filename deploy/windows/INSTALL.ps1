$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Set-DotEnvValue {
  param([string]$Path, [string]$Name, [string]$Value)
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $Path)
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match ('^' + [regex]::Escape($Name) + '=')) {
      $lines[$index] = "$Name=$Value"
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add("$Name=$Value") }
  Set-Content -LiteralPath $Path -Value $lines -Encoding utf8
}

Write-Host 'Photo Booth - Windows installation' -ForegroundColor Cyan
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run INSTALL.cmd again.'
}
$nodeMajor = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw 'Node.js 20 or newer is required. Node.js 22 LTS is recommended.' }

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw 'npm.cmd was not found. Reinstall Node.js 22 LTS and enable Add to PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'package-lock.json'))) { throw 'package-lock.json is missing from this package.' }

$envFile = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination $envFile
  $randomBytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Set-DotEnvValue -Path $envFile -Name 'IPAD_API_TOKEN' -Value $token
  Set-DotEnvValue -Path $envFile -Name 'CAPTURE_SOURCE' -Value 'digicam'
  Set-DotEnvValue -Path $envFile -Name 'KIOSK_MODE' -Value 'self_service'
  Write-Host 'Created a new .env with a unique API token.' -ForegroundColor Green
} else {
  Write-Host 'Existing .env was preserved.' -ForegroundColor Yellow
}

$captureDir = 'C:\photobooth-captures'
New-Item -ItemType Directory -Path $captureDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'sessions') -Force | Out-Null

Write-Host 'Installing application dependencies...'
& $npm ci --omit=dev --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }

Write-Host 'Creating desktop shortcuts and automatic startup...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'launch\install-shortcuts.ps1')
if ($LASTEXITCODE -ne 0) { throw "Shortcut installation failed with exit code $LASTEXITCODE" }

$dcc = 'C:\Program Files (x86)\digiCamControl\CameraControl.exe'
if (-not (Test-Path -LiteralPath $dcc)) {
  Write-Warning 'digiCamControl was not found. Install digiCamControl 2.1.7, then restart Windows.'
}

$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if ($cloudflared) {
  $binDir = Join-Path $env:LOCALAPPDATA 'PhotoBooth\bin'
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  Copy-Item -LiteralPath $cloudflared.Source -Destination (Join-Path $binDir 'cloudflared.exe') -Force
}

Write-Host ''
Write-Host 'Core installation is complete.' -ForegroundColor Green
Write-Host "1. Open $envFile and enter Nextcloud values."
Write-Host '2. Install digiCamControl and connect your camera by USB to this Windows computer.'
Write-Host '3. Follow README-INSTALL.txt to move or create the Cloudflare Tunnel credentials.'
Write-Host '4. Restart Windows, then open https://booth.ienas.site on the iPad.'
