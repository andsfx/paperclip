@echo off
rem ============================================================
rem  Paperclip CLI wrapper
rem  Selalu memakai D:\Andy\paperclip\.paperclip sebagai home,
rem  tanpa bergantung pada environment variable Windows.
rem  Contoh:  paperclip.cmd doctor
rem           paperclip.cmd --version
rem ============================================================
setlocal
set "PAPERCLIP_HOME=%~dp0.paperclip"
npx paperclipai %*
