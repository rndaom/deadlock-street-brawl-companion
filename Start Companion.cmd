@echo off
setlocal
if not exist "%~dp0release\win-unpacked\Street Brawl Companion.exe" (
  echo The Windows application has not been packaged yet.
  echo Run "npm ci" and then "npm run package:dir" in this folder first.
  pause
  exit /b 1
)
start "" "%~dp0release\win-unpacked\Street Brawl Companion.exe"
