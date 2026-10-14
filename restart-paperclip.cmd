@echo off
rem ============================================================
rem  Restart Paperclip dengan bersih.
rem
rem  Mematikan SEMUA proses Paperclip lama (server, npx, cmd, postgres)
rem  dan memastikan benar-benar mati sebelum menjalankan satu instance
rem  baru. Mencegah jendela dan proses menumpuk di terminal.
rem
rem  Contoh:  restart-paperclip.cmd
rem           restart-paperclip.cmd --status
rem           restart-paperclip.cmd --stop
rem ============================================================
setlocal
node "%~dp0scripts\restart-paperclip.mjs" %*
