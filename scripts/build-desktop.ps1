<#
Build the Windows desktop package and installer.

Two artefacts:
  1. AgentOrchestrator-v<ver>-win64.zip  — portable, unzip and run
  2. AgentOrchestrator-Setup-v<ver>.exe  — IExpress installer

Run from the repository root:
  & "$env:LOCALAPPDATA\Programs\PowerShell\7\pwsh.exe" -NoProfile -File scripts/build-desktop.ps1
#>

param(
  [string]$ElectronDist = "node_modules\electron\dist",
  [string]$SevenZip = "C:\Program Files\7-Zip\7z.exe",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path ".").Path

function Assert-Under($path, $parent) {
  $full = [System.IO.Path]::GetFullPath($path)
  $root = [System.IO.Path]::GetFullPath($parent)
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to touch $full; it is outside $root"
  }
  return $full
}

# --- 0. Preconditions ------------------------------------------------------
if (-not (Test-Path $ElectronDist)) {
  throw "Electron dist not found at $ElectronDist. Run: node node_modules/electron/install.js"
}
if (-not (Test-Path $SevenZip)) {
  throw "7-Zip not found at $SevenZip"
}
if (-not (Test-Path "dist\workflow\server.js")) {
  throw "dist is missing. Run: npm run build"
}

$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$version = $pkg.version
$name = "AgentOrchestrator"

$stage = Join-Path $env:TEMP ("ao-build-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$appRoot = Join-Path $stage $name
$resources = Join-Path $appRoot "resources"
$appDir = Join-Path $resources "app"

Write-Output "[1/6] staging $appRoot"
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Get-ChildItem $ElectronDist | Copy-Item -Destination $appRoot -Recurse -Force
$exe = Join-Path $appRoot "electron.exe"
Rename-Item $exe "$name.exe"

Write-Output "[2/6] copying the app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "app") | Out-Null
foreach ($item in @("dist", "src", "tools", "bin", "docs", "skills", "deepseek-plugin")) {
  Copy-Item $item $appDir -Recurse -Force
}
Copy-Item "app\main.cjs", "app\panel-host.cjs" (Join-Path $appDir "app") -Force
Copy-Item "package.json", ".env.example", "README.md" $appDir -Force

Write-Output "[3/6] installing production dependencies"
Push-Location $appDir
try {
  npm install --omit=dev --no-audit --no-fund 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Output $_ }
} finally {
  Pop-Location
}

Write-Output "[4/6] smoke test"
$smokeState = Join-Path $stage "smoke-state"
$env:PANEL_SMOKE = "1"
$env:PANEL_STATE = $smokeState
$proc = Start-Process -FilePath (Join-Path $appRoot "$name.exe") -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput (Join-Path $stage "smoke.out") `
  -RedirectStandardError (Join-Path $stage "smoke.err")
$out = Get-Content (Join-Path $stage "smoke.out") -Raw
Write-Output $out
if ($proc.ExitCode -ne 0) {
  Write-Output (Get-Content (Join-Path $stage "smoke.err") -Tail 20)
  throw "smoke test failed with exit $($proc.ExitCode)"
}
Remove-Item Env:\PANEL_SMOKE -ErrorAction SilentlyContinue
Remove-Item Env:\PANEL_STATE -ErrorAction SilentlyContinue

if ($out -notmatch 'smoke: ok') {
  throw "smoke test did not report ok"
}

Write-Output "[5/6] archiving portable zip"
if (-not $OutDir) {
  $OutDir = Join-Path $repo "outputs\desktop"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "$name-v$version-win64.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
& $SevenZip a -tzip -mx=5 -mmt=on $zip $stage\$name 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Output $_ }
$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output "  -> $zip ($zipSize MB)"

Write-Output "[6/6] building installer payload"
$payload = Join-Path $stage "payload"
New-Item -ItemType Directory -Force -Path $payload | Out-Null
& $SevenZip a -t7z -mx=5 -mmt=on (Join-Path $payload "app.7z") (Join-Path $appRoot "*") 2>&1 |
  Select-Object -Last 2 | ForEach-Object { Write-Output $_ }
Copy-Item $SevenZip $payload -Force
Copy-Item (Join-Path (Split-Path $SevenZip -Parent) "7z.dll") $payload -Force
Copy-Item (Join-Path (Split-Path $SevenZip -Parent) "License.txt") (Join-Path $payload "7-ZIP-LICENSE.txt") -Force
Copy-Item "packaging\install.cmd" $payload -Force
Copy-Item "packaging\uninstall.cmd" $payload -Force

Write-Output "payload: $([math]::Round((Get-ChildItem $payload -File | Measure-Object Length -Sum).Sum / 1MB, 1)) MB"
Write-Output ""
Write-Output "Next:"
Write-Output "  & `"$env:LOCALAPPDATA\Programs\PowerShell\7\pwsh.exe`" -NoProfile -File packaging\build-setup.ps1 -PayloadDir `"$payload`" -TargetName `"$name-Setup-v$version.exe`""
Write-Output ""
Write-Output "staging kept at: $stage"
