@echo off
setlocal
py -3 --version >nul 2>&1
if errorlevel 1 (
    python "%~dp0start_demo.py"
) else (
    py -3 "%~dp0start_demo.py"
)
if errorlevel 1 pause
