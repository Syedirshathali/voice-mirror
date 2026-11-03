@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto done
)
echo Python 3 was not found.
echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run this again.
:done
pause
