@echo off
setlocal
rem Windows launcher for workbuddy-gateway.
rem Mirrors bin/workbuddy-gateway: resolve the project root, load .env, then
rem run the compiled entry point with the configured node binary.
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if exist "%ROOT%\.env" call "%~dp0_load-env.cmd" "%ROOT%\.env"
if not defined WORKBUDDY_NODE_BIN set "WORKBUDDY_NODE_BIN=node"
"%WORKBUDDY_NODE_BIN%" "%ROOT%\dist\server.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
