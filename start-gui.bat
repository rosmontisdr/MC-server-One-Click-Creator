@echo off
rem mcsp launcher - must stay pure ASCII.
rem cmd.exe parses .bat by the system ANSI codepage (CP936 on Chinese Windows), so a
rem UTF-8 Chinese string would shift the byte stream and swallow the ASCII right after it.
rem All Chinese output comes from PowerShell/Node instead, which write through the Windows
rem Unicode API and are unaffected.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required but was not found in PATH.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
rem Do not weaken the execution policy here. If this machine forbids running .ps1 files,
rem tell the user how to allow it and let them decide.
for /f "delims=" %%p in ('powershell.exe -NoProfile -Command "(Get-ExecutionPolicy)"') do set POLICY=%%p
if /i "%POLICY%"=="Restricted" goto blocked
if /i "%POLICY%"=="AllSigned" goto blocked
rem -STA: WPF windows need a single-threaded apartment.
rem No -WindowStyle Hidden here on purpose: if the script fails to start (blocked by policy,
rem or the file carries a zone mark from being downloaded), the console stays visible with the
rem error instead of vanishing. gui.ps1 hides its own console once the window is actually up.
start "" powershell.exe -NoProfile -STA -File "%~dp0gui.ps1"
exit /b 0

:blocked
echo This machine does not allow running PowerShell scripts ^(policy: %POLICY%^).
echo Either allow it once for your own user:
echo     powershell -Scope CurrentUser Set-ExecutionPolicy RemoteSigned
echo or start the launcher with the policy relaxed for this run only:
echo     powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0gui.ps1"
pause
exit /b 1
