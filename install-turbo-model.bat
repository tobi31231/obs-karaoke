@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=python"
if exist "python\python.exe" set "PYTHON_EXE=python\python.exe"

if "%PYTHON_EXE%"=="python" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3.10 or newer is required.
    pause
    exit /b 1
  )
  if not exist ".venv\Scripts\python.exe" python -m venv .venv
  set "PYTHON_EXE=.venv\Scripts\python.exe"
)

"%PYTHON_EXE%" -m pip install -r requirements-whisper.txt --upgrade --progress-bar off --disable-pip-version-check
if errorlevel 1 exit /b 1
"%PYTHON_EXE%" work\download_model.py turbo
if errorlevel 1 exit /b 1
"%PYTHON_EXE%" work\download_cuda_runtime.py
if errorlevel 1 (
  echo WARNING: CUDA runtime download failed. CPU analysis is still available.
)

echo.
echo Turbo model is installed. Restart the app if it is already running.
pause
