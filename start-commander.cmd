@echo off
rem start-commander.cmd - khoi dong tele-commander (chu khong dau).
rem Khong loop: thoat bat thuong thi in ma thoat + pause.
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay node. Cai NodeJS tu 22.14 tro len roi chay lai.
  pause
  exit /b 1
)
if not exist .env (
  echo [LOI] Thieu file .env. Copy .env.example sang .env roi dien:
  echo   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS
  echo Xong chay: npm run doctor
  pause
  exit /b 1
)
node src\bot.js
set CODE=%errorlevel%
if not "%CODE%"=="0" (
  echo [LOI] Bot thoat bat thuong, ma thoat: %CODE%. Xem logs\bot.log.
  pause
  exit /b %CODE%
)
