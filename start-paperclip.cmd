@echo off
rem ============================================================
rem  Jalankan server Paperclip (foreground)
rem  Instance: D:\Andy\paperclip\.paperclip\instances\default
rem  UI/API  : http://127.0.0.1:3100
rem  Tutup jendela ini untuk menghentikan server.
rem ============================================================
setlocal
set "PAPERCLIP_HOME=%~dp0.paperclip"
echo Memeriksa patch lokal (adapter guard + npm Windows + git config Windows) ...
node "%~dp0scripts\apply-patches.mjs"
echo Memulai Paperclip dari %PAPERCLIP_HOME% ...
npx paperclipai run -d "%~dp0.paperclip"
echo.
echo Server berhenti.
pause
