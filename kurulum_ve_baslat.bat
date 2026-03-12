@echo off
setlocal
cd /d "%~dp0"

echo [1/3] Node.js Kontrol Ediliyor...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Node.js yuklu degil! 
    echo Lutfen https://nodejs.org/ adresinden LTS surumunu indirip kurun.
    pause
    exit /b
)

if not exist "node_modules\" (
    echo [2/3] Bagimliliklar yukleniyor (Bu biraz zaman alabilir)...
    call npm install
) else (
    echo [2/3] Bagimliliklar zaten yuklu.
)

echo [3/3] Uygulama baslatiliyor...
npm start

pause
