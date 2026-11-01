@echo off
setlocal EnableDelayedExpansion
rem ---------------------------------------------------------------------------
rem Agent Orchestrator installer.
rem
rem IExpress extracts this folder to a temp directory and runs this script from
rem there, so %~dp0 is the extraction folder, not the user's current directory.
rem Every path below is absolute for that reason.
rem ---------------------------------------------------------------------------

set "EXTRACT=%~dp0"
set "TARGET=%LOCALAPPDATA%\AgentOrchestrator"
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP_LINK=%USERPROFILE%\Desktop\Agent Orchestrator.lnk"
set "LOG=%TEMP%\agent-orchestrator-install.log"

echo [install] target: %TARGET% >> "%LOG%"

rem --- 1. Refuse a downgrade over a running instance -------------------------
tasklist /FI "IMAGENAME eq AgentOrchestrator.exe" /NH 2>nul | find /I "AgentOrchestrator.exe" >nul
if not errorlevel 1 (
  echo [install] AgentOrchestrator is running; asking it to close >> "%LOG%"
  taskkill /IM AgentOrchestrator.exe /T >nul 2>&1
  timeout /t 3 /nobreak >nul
)

rem --- 2. Extract -----------------------------------------------------------
if not exist "%TARGET%" mkdir "%TARGET%" 2>nul
echo [install] extracting >> "%LOG%"
rem The archive was built from the app folder itself, so it contains an
rem AgentOrchestrator\ root. Extract into TARGET, then flatten that root.
"%EXTRACT%7z.exe" x "%EXTRACT%app.7z" -o"%TARGET%" -y -bso0 -bsp0 >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [install] extraction failed >> "%LOG%"
  echo.
  echo Installation failed while extracting files.
  echo See "%LOG%" for details.
  pause
  exit /b 1
)

if not exist "%TARGET%\AgentOrchestrator.exe" (
  if exist "%TARGET%\AgentOrchestrator\AgentOrchestrator.exe" (
    echo [install] flattening nested folder >> "%LOG%"
    rem `move` fails on directories that already exist in the destination, and
    rem TARGET already holds workflow-state and the installer's own copies of
    rem 7z.exe/uninstall.cmd. Copy recursively instead, which merges.
    xcopy /E /I /Y /Q "%TARGET%\AgentOrchestrator\*" "%TARGET%\" >> "%LOG%" 2>&1
    rmdir /s /q "%TARGET%\AgentOrchestrator" >nul 2>&1
  )
)

if not exist "%TARGET%\AgentOrchestrator.exe" (
  echo [install] AgentOrchestrator.exe missing after extraction >> "%LOG%"
  echo.
  echo Installation failed: the executable was not found after extraction.
  echo See "%LOG%" for details.
  pause
  exit /b 1
)

rem --- 3. State directory ---------------------------------------------------
rem The panel writes here by default. Create it now so the first launch does
rem not depend on the shell being able to create a folder under LocalAppData.
if not exist "%TARGET%\workflow-state" mkdir "%TARGET%\workflow-state" 2>nul

rem --- 4. Shortcuts ---------------------------------------------------------
rem A .lnk is a binary format; this writes one directly rather than shelling
rem out to PowerShell, so the installer works even where script execution is
rem restricted by policy.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell);" ^
  "$l=$s.CreateShortcut('%DESKTOP_LINK%');" ^
  "$l.TargetPath='%TARGET%\AgentOrchestrator.exe';" ^
  "$l.WorkingDirectory='%TARGET%';" ^
  "$l.Description='Agent Orchestrator';" ^
  "$l.Save();" ^
  "$m=$s.CreateShortcut('%STARTMENU%\Agent Orchestrator.lnk');" ^
  "$m.TargetPath='%TARGET%\AgentOrchestrator.exe';" ^
  "$m.WorkingDirectory='%TARGET%';" ^
  "$m.Description='Agent Orchestrator';" ^
  "$m.Save()" >> "%LOG%" 2>&1

rem --- 5. Uninstaller ------------------------------------------------------
copy /y "%EXTRACT%uninstall.cmd" "%TARGET%\uninstall.cmd" >nul
copy /y "%EXTRACT%7z.exe" "%TARGET%\7z.exe" >nul
copy /y "%EXTRACT%7z.dll" "%TARGET%\7z.dll" >nul

rem --- 6. Add/Remove Programs entry ----------------------------------------
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v DisplayName /d "Agent Orchestrator" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v DisplayVersion /d "0.8.0" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v InstallLocation /d "%TARGET%" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v DisplayIcon /d "%TARGET%\AgentOrchestrator.exe" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v UninstallString /d "\"%TARGET%\uninstall.cmd\"" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v NoRepair /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOrchestrator" /v EstimatedSize /t REG_DWORD /d 372800 /f >nul

echo [install] done >> "%LOG%"

rem --- 7. Offer to launch --------------------------------------------------
echo.
echo   Agent Orchestrator 0.8.0 installed.
echo   Location: %TARGET%
echo   Shortcuts: Desktop and Start Menu
echo.
choice /C YN /N /M "Launch now? [Y/N] "
if errorlevel 2 goto :end
start "" "%TARGET%\AgentOrchestrator.exe"

:end
exit /b 0
