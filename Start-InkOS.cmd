@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-InkOS.ps1" %*
if errorlevel 1 pause
