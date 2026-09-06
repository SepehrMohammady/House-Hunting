@echo off
REM Wrapper used by Task Scheduler.
REM
REM Exists so the scheduled task has a stable entry point that sets its own
REM working directory and appends to a log. Calling node directly from the task
REM works until the day you need to debug why the 06:00 run produced nothing.

setlocal

REM %~dp0 is this script's folder; the project root is its parent.
set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

if not exist "data" mkdir "data"

echo. >> "data\run.log"
echo ======================================== >> "data\run.log"
echo Run started %DATE% %TIME% >> "data\run.log"

node src\index.js --quiet >> "data\run.log" 2>&1
set "EXITCODE=%ERRORLEVEL%"

echo Run finished %DATE% %TIME% (exit %EXITCODE%) >> "data\run.log"

REM Keep the log from growing without bound - trim to the last ~2000 lines.
for /f %%A in ('find /c /v "" ^< "data\run.log"') do set "LINES=%%A"
if %LINES% GTR 4000 (
    powershell -NoProfile -Command "Get-Content 'data\run.log' -Tail 2000 | Set-Content 'data\run.log.tmp' -Encoding utf8; Move-Item -Force 'data\run.log.tmp' 'data\run.log'"
)

exit /b %EXITCODE%
