@echo off
setlocal
rem Windows launcher for agent-hub.
rem AGENT_HUB_CALLER_CWD tells the hub where the user actually stood, which
rem matters because the launcher changes into the project root.
set "AGENT_HUB_CALLER_CWD=%CD%"
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if exist "%ROOT%\.env" call "%~dp0_load-env.cmd" "%ROOT%\.env"
if not defined WORKBUDDY_NODE_BIN set "WORKBUDDY_NODE_BIN=node"
"%WORKBUDDY_NODE_BIN%" "%ROOT%\dist\platform\cli.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
