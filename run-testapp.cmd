@echo off
REM Build the extension, then open the test app in Studio Pro with the extension flag set.
REM   run-testapp.cmd            build, then launch
REM   run-testapp.cmd --no-build launch whatever is already deployed
REM
REM Structured with goto labels rather than parenthesised if-blocks on purpose. cmd expands %VAR%
REM when it PARSES a block, not when it runs each line, so inside a block both `set "RC=%errorlevel%"`
REM and a later `if not "%RC%"=="0"` see values from before the block ever ran. The built-in
REM `if errorlevel N` test used below is evaluated at execution time and has no such problem.
setlocal
cd /d "%~dp0"

set "DOBUILD=1"
if /I "%~1"=="--no-build" set "DOBUILD=0"
if /I "%~1"=="-n" set "DOBUILD=0"

if "%DOBUILD%"=="0" goto :launch

where npm >nul 2>nul
if errorlevel 1 goto :nonpm

if exist "extension\node_modules" goto :build

echo Installing dependencies...
pushd extension
call npm install
if errorlevel 1 goto :installfailed
popd

:build
echo Building extension...
pushd extension
call npm run build
if errorlevel 1 goto :buildfailed
popd

:launch
call "%~dp0tools\run-studiopro.cmd" -NoWait
exit /b 0

:nonpm
echo npm was not found on PATH. Install Node.js, or pass --no-build.
exit /b 1

:installfailed
popd
echo npm install failed.
exit /b 1

:buildfailed
popd
echo.
echo Build failed, so Studio Pro was NOT launched. Launching anyway would have tested the
echo previously deployed extension, not your current code.
exit /b 1
