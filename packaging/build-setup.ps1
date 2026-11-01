<#
Build the Windows installer with IExpress.

Why IExpress: this machine has no NSIS or Inno Setup, and both the GitHub
release and the npmmirror copy of NSIS are unreachable. IExpress ships with
Windows and can run a script after extracting.

The payload is a 7z archive plus a copy of 7z.exe, because IExpress compresses
with makecab, which took minutes on a 110 MB archive and is slow to extract.
#>

param(
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [string]$TargetName = "AgentOrchestrator-Setup.exe"
)

$ErrorActionPreference = "Stop"
$PayloadDir = (Resolve-Path $PayloadDir).Path
$target = Join-Path $PayloadDir $TargetName
if (Test-Path $target) { Remove-Item -LiteralPath $target -Force }

$files = @("app.7z", "7z.exe", "7z.dll", "install.cmd", "uninstall.cmd", "7-ZIP-LICENSE.txt")
foreach ($name in $files) {
  if (-not (Test-Path (Join-Path $PayloadDir $name))) {
    throw "Missing payload file: $name"
  }
}

$strings = for ($i = 0; $i -lt $files.Count; $i++) { "FILE$i=`"$($files[$i])`"" }
$sources = for ($i = 0; $i -lt $files.Count; $i++) { "%FILE$i%=" }

$sed = @(
  "[Version]",
  "Class=IEXPRESS",
  "SEDVersion=3",
  "[Options]",
  "PackagePurpose=InstallApp",
  "ShowInstallProgramWindow=0",
  "HideExtractAnimation=1",
  "UseLongFileName=1",
  "InsideUNInstEXE=0",
  "AppLaunched=install.cmd",
  "PostInstallCmd=<None>",
  "AdminQuietInstCmd=",
  "UserQuietInstCmd=",
  "TargetName=$target",
  "SourceFiles=SourceFiles",
  "[Strings]",
  $strings,
  "[SourceFiles]",
  "SourceFiles0=$PayloadDir",
  "[SourceFiles0]",
  $sources
)

$sedFile = Join-Path $PayloadDir "setup.sed"
Set-Content -Path $sedFile -Value $sed -Encoding ASCII

$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
$proc = Start-Process -FilePath $iexpress -ArgumentList "/N", $sedFile, "/Q" -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) { throw "iexpress exited $($proc.ExitCode)" }
if (-not (Test-Path $target)) { throw "iexpress produced no installer" }

$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Output "built $target ($size MB)"
