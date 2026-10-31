@echo off
setlocal
rem Windows launcher for the WorkBuddy CLI.
rem The POSIX version hardcodes macOS application paths. Here both the Electron
rem binary and the CLI script must be supplied, because there is no single
rem Windows install location to guess.
if not defined WORKBUDDY_CLI_ELECTRON (
  echo Set WORKBUDDY_CLI_ELECTRON to the WorkBuddy Electron executable. 1>&2
  exit /b 1
)
if not defined WORKBUDDY_CLI_SCRIPT (
  echo Set WORKBUDDY_CLI_SCRIPT to the codebuddy CLI script. 1>&2
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
set "CODEBUDDY_FORCE_HEADLESS_BUNDLE=1"
"%WORKBUDDY_CLI_ELECTRON%" "%WORKBUDDY_CLI_SCRIPT%" %*
exit /b %ERRORLEVEL%
