@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo This local config tool needs the Node.js runtime used by this workspace.
  pause
  exit /b 1
)
echo 1. Prepare FPS-first candidate ^(67%% scale; no game changes^)
echo 2. Apply latest prepared config ^(quit Deadlock first^)
echo 3. Verify applied settings on disk
echo 4. Restore settings from last application backup
choice /c 1234 /n /m "Select an action: "
if errorlevel 5 goto finish
if errorlevel 4 goto restore
if errorlevel 3 goto verify
if errorlevel 2 goto apply
if errorlevel 1 goto prepare
goto finish
:prepare
node optimization/tools/optimizer.mjs prepare --profile fpsfirst
goto finish
:apply
node optimization/tools/optimizer.mjs apply
goto finish
:verify
node optimization/tools/optimizer.mjs verify --profile installed
goto finish
:restore
node optimization/tools/optimizer.mjs restore
goto finish
:finish
pause
