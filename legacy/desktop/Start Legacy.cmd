@echo off
setlocal
title Legacy AI
cd /d "%~dp0"
set "PATH=%~dp0runtime;%PATH%"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "AGENT_BROWSER_EXECUTABLE_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "AGENT_BROWSER_EXECUTABLE_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if /i "%~1"=="browser" (
  "%~dp0runtime\node.exe" src\setup-browser.js
  pause
  exit /b
)
"%~dp0runtime\node.exe" src\desktop.js "%~1"
if errorlevel 1 (
  echo.
  echo Legacy AI stopped. Check the message above.
  pause
)
