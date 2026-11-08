@echo off
echo ============================================================
echo   FMCG Microservices - Push to GitHub
echo ============================================================
echo.

cd /d "%~dp0"

:: Check if remote is already added
git remote get-url origin >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/2] Setting GitHub remote origin...
    git remote add origin https://github.com/Arhaanx5/fmcg-microservices.git
)

echo [2/2] Pushing main branch to GitHub...
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo [SUCCESS] fmcg-microservices pushed to GitHub!
    echo Next step: Deploy on Render Account 2 using Blueprint!
    echo ============================================================
) else (
    echo.
    echo [ERROR] Push failed. Make sure you created the repo on GitHub:
    echo https://github.com/new (Name: fmcg-microservices)
)

pause

