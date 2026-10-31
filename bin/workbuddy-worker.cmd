@echo off
setlocal
rem Windows launcher for workbuddy-worker.
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if exist "%ROOT%\.env" call "%~dp0_load-env.cmd" "%ROOT%\.env"
if not defined WORKBUDDY_NODE_BIN set "WORKBUDDY_NODE_BIN=node"
"%WORKBUDDY_NODE_BIN%" "%ROOT%\dist\desktop-worker-cli.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
