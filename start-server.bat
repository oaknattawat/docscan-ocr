@echo off
title DocScan OCR Server

:MENU
cls
echo ============================================
echo        DocScan OCR Server
echo        http://localhost:3000
echo ============================================
echo.
echo   [R] = Open Server (PC + Mobile Wi-Fi)
echo   [E] = Close Server
echo.
set /p "key=Press R or E: "
if /i "%key%"=="R" goto START
if /i "%key%"=="E" goto STOP
goto MENU

:START
cls
echo ============================================
echo   Server is running!
echo.
echo   On this PC:
echo     http://localhost:3000
echo.
echo   On Mobile (same Wi-Fi):
set "LAN_IP="
for /f "usebackq delims=" %%i in (`python -c "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('10.255.255.255',1)); print(s.getsockname()[0]); s.close()" 2^>nul`) do set "LAN_IP=%%i"
if not defined LAN_IP (
  for /f "usebackq delims=" %%i in (`python -c "import socket; print(socket.gethostbyname(socket.gethostname()))" 2^>nul`) do set "LAN_IP=%%i"
)
if defined LAN_IP (
  echo     http://%LAN_IP%:3000
) else (
  echo     Check IP with ipconfig (port 3000)
)
echo ============================================
echo.
start "" http://localhost:3000
python -m http.server 3000 --directory "%~dp0"
goto MENU

:STOP
cls
echo Closing Server...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo Server closed.
echo.
pause
exit
