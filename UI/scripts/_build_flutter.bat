@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" > nul 2>&1
cd /d "C:\Users\yangx\Desktop\SoloForge\UI\resources\canvas\canvas_preview"
C:\tools\flutter\bin\flutter.bat build windows --debug
exit /b %ERRORLEVEL%
