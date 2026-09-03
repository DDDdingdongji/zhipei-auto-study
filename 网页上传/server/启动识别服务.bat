@echo off
cd /d "%~dp0"
echo ==========================================
echo   验证码识别服务（配合自动刷课脚本使用）
echo   地址: http://127.0.0.1:8765
echo   关闭本窗口即停止服务
echo ==========================================
echo.
echo 正在清理残留的旧服务进程...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*captcha_server.py*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.
python captcha_server.py
pause
