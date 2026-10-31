@echo off
setlocal
rem Windows launcher for workbuddy-doctor.
rem The POSIX version refuses to run before a build; this one does the same.
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if exist "%ROOT%\.env" call "%~dp0_load-env.cmd" "%ROOT%\.env"
if not defined WORKBUDDY_NODE_BIN set "WORKBUDDY_NODE_BIN=node"
if not exist "%ROOT%\dist\doctor.js" (
  echo Build the project first: npm run build 1>&2
  popd >nul
  exit /b 1
)
"%WORKBUDDY_NODE_BIN%" "%ROOT%\dist\doctor.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
