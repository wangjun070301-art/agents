#Requires -Version 7
<#
  Runs Claude Code as the independent reviewer against this repository.

  The gateway this machine talks to keys models by ids that contain spaces and
  parentheses. Claude Code strips those characters before sending, so the
  upstream answers 503. tools/model-shim.mjs rewrites the id back; this script
  starts the shim if it is not already listening and then runs Claude Code with
  clean alias ids that the shim maps to real gateway models.

  The gateway token is read from ~/.claude/settings.json at runtime and is never
  written into this repository.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Prompt,

  [string] $Model = 'claude-haiku-4-5',

  [string[]] $AllowedTools = @('Read', 'Bash', 'Grep', 'Glob'),

  [string] $RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
  throw "Claude Code settings not found at $settingsPath"
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$gateway = $settings.env.ANTHROPIC_BASE_URL
$token = $settings.env.ANTHROPIC_AUTH_TOKEN
if (-not $gateway -or -not $token) {
  throw 'ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be present in settings.json'
}

$shimPort = 18777
$shimScript = Join-Path $RepoRoot 'tools\model-shim.mjs'
$shimLog = Join-Path $env:TEMP 'agents-model-shim.log'
$shimErr = Join-Path $env:TEMP 'agents-model-shim.err.log'

# Model ids are read from the gateway so the map stays correct if the gateway
# renames or adds models.
$headers = @{ 'x-api-key' = $token; 'anthropic-version' = '2023-06-01' }
$list = Invoke-RestMethod -Uri "$($gateway.TrimEnd('/'))/models" -Headers $headers -TimeoutSec 20
$realIds = @($list.data | ForEach-Object { $_.id })
if ($realIds.Count -eq 0) { throw 'gateway returned no models' }

$fast = ($realIds | Where-Object { $_ -match 'V4\.1-Flash' } | Select-Object -First 1)
$strong = ($realIds | Where-Object { $_ -match 'V4-Pro' } | Select-Object -First 1)
if (-not $fast) { $fast = $realIds[0] }
if (-not $strong) { $strong = $fast }

$map = @{
  'claude-sonnet-4-5' = $fast
  'claude-haiku-4-5'  = $fast
  'claude-opus-4-5'   = $strong
} | ConvertTo-Json -Compress

$listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $shimPort -WarningAction SilentlyContinue).TcpTestSucceeded
if (-not $listening) {
  $env:SHIM_UPSTREAM = $gateway
  $env:SHIM_TOKEN = $token
  $env:SHIM_PORT = "$shimPort"
  $env:SHIM_MAP = $map
  Start-Process -FilePath 'node' -ArgumentList $shimScript `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $shimLog -RedirectStandardError $shimErr `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $shimPort -WarningAction SilentlyContinue).TcpTestSucceeded
  } while (-not $listening -and (Get-Date) -lt $deadline)
  if (-not $listening) {
    throw "model shim did not start; see $shimErr"
  }
}

$overrideFile = Join-Path $env:TEMP 'agents-claude-shim-settings.json'
@{
  env = @{
    ANTHROPIC_BASE_URL = "http://127.0.0.1:$shimPort"
    ANTHROPIC_AUTH_TOKEN = $token
    ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-5'
    ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5'
    ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-5'
    ANTHROPIC_MODEL = $Model
  }
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $overrideFile -Encoding utf8

Push-Location $RepoRoot
try {
  $args = @(
    '-p', $Prompt,
    '--output-format', 'text',
    '--settings', $overrideFile,
    '--model', $Model
  )
  if ($AllowedTools.Count -gt 0) {
    $args += @('--allowedTools', ($AllowedTools -join ','))
  }
  & claude @args
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item -LiteralPath $overrideFile -Force -ErrorAction SilentlyContinue
}

exit $code
