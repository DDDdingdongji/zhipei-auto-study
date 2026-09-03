@echo off
cd /d "%~dp0"
echo ==========================================
echo   Captcha OCR Server (for Auto-Study script)
echo   URL: http://127.0.0.1:8765
echo   Close this window to stop the service.
echo ==========================================
echo.
echo Cleaning up stale server processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*captcha_server.py*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.
python captcha_server.py
pause