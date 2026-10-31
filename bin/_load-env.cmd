@echo off
rem Load KEY=VALUE pairs from a .env file into the environment.
rem Only lines of that shape are read; comments and blanks are skipped. The
rem value is taken verbatim, which is what the POSIX launchers do with `set -a`
rem and `. "$ROOT/.env"`.
setlocal EnableDelayedExpansion
for /f "usebackq tokens=1* delims==" %%A in ("%~1") do (
  set "LINE=%%A"
  if not "!LINE!"=="" (
    echo !LINE! | findstr /r /c:"^ *#" >nul
    if errorlevel 1 (
      echo !LINE! | findstr /r /c:"^ *rem " >nul
      if errorlevel 1 (
        endlocal & set "%%A=%%B"
        setlocal EnableDelayedExpansion
      )
    )
  )
)
endlocal
exit /b 0
