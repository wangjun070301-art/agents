@echo off
setlocal EnableDelayedExpansion
rem ---------------------------------------------------------------------------
rem Agent Orchestrator uninstaller.
rem
rem Removes the program, shortcuts and the Add/Remove Programs entry. It asks
rem before deleting workflow-state, because that directory holds the user's
rem pipeline history and project configuration.
rem
rem A batch file cannot delete itself and then keep running, so when this is
rem launched from the install directory it re-launches a copy from %TEMP%.
rem ---------------------------------------------------------------------------

set "TARGET=%~dp0"
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

rem Re-launch from a copy unless we are already that copy. The check is on the
rem script path alone: gating it on the executable existing meant an install
rem with an unexpected layout deleted its own script mid-run.
if /I "%~f0" neq "%TEMP%\agent-orchestrator-uninstall.cmd" (
  copy /y "%~f0" "%TEMP%\agent-orchestrator-uninstall.cmd" >nul
  cmd /c ""%TEMP%\agent-orchestrator-uninstall.cmd" /from:%TARGET%"
  exit /b 0
)

rem When re-launched from the copy, the first argument carries the real target.
if /I "%1" neq "" (
  set "ARG=%~1"
  if /I "!ARG:~0,6!"=="/from:" set "TARGET=!ARG:~6!"
)
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP_LINK=%USERPROFILE%\Desktop\Agent Orchestrator.lnk"
set "REGKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator"

echo.
echo   Uninstall Agent Orchestrator
echo   Location: %TARGET%
echo.

tasklist /FI "IMAGENAME eq AgentOrchestrator.exe" /NH 2>nul | find /I "AgentOrchestrator.exe" >nul
if not errorlevel 1 (
  echo   Closing Agent Orchestrator...
  taskkill /IM AgentOrchestrator.exe /T >nul 2>&1
  timeout /t 3 /nobreak >nul
)

choice /C YN /N /M "Also delete workflow-state (pipeline history and project config)? [Y/N] "
set "PURGE_STATE=0"
if errorlevel 2 goto :keep_state
set "PURGE_STATE=1"

:keep_state
echo   Removing files...
del /f /q "%TARGET%\AgentOrchestrator.exe" >nul 2>&1
for %%F in (chrome_100_percent.pak chrome_200_percent.pak d3dcompiler_47.dll dxcompiler.dll electron_wer.dll ffmpeg.dll icudtl.dat LICENSE LICENSES.chromium.html resources.pak snapshot_blob.bin v8_context_snapshot.bin version vk_swiftshader_icd.json vk_swiftshader.dll vulkan-1.dll uninstall.cmd 7z.exe 7z.dll) do (
  del /f /q "%TARGET%\%%F" >nul 2>&1
)
if exist "%TARGET%\locales" rmdir /s /q "%TARGET%\locales" >nul 2>&1
if exist "%TARGET%\resources" rmdir /s /q "%TARGET%\resources" >nul 2>&1

if "%PURGE_STATE%"=="1" (
  if exist "%TARGET%\workflow-state" rmdir /s /q "%TARGET%\workflow-state" >nul 2>&1
)

del /f /q "%DESKTOP_LINK%" >nul 2>&1
del /f /q "%STARTMENU%\Agent Orchestrator.lnk" >nul 2>&1
reg delete "%REGKEY%" /f >nul 2>&1

rem Remove the directory only when nothing of the user's remains inside it.
if "%PURGE_STATE%"=="1" (
  if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>&1
) else (
  if exist "%TARGET%\workflow-state" (
    echo.
    echo   Kept: %TARGET%\workflow-state
    echo   Delete that folder yourself when you no longer need the history.
  )
)

echo.
echo   Uninstalled.
echo.
pause
exit /b 0
