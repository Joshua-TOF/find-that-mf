@echo off
REM Windows defaults PowerShell's execution policy to Restricted, which blocks the .ps1 outright.
REM This wrapper sets Bypass for one process only, so it works on a locked-down machine.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-studiopro.ps1" %*
