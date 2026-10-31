@echo off
setlocal
rem Windows launcher for deepseek-gateway.
rem The POSIX version does not load .env; neither does this one.
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if not defined DEEPSEEK_NODE_BIN set "DEEPSEEK_NODE_BIN=node"
"%DEEPSEEK_NODE_BIN%" "%ROOT%\dist\deepseek-server.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
