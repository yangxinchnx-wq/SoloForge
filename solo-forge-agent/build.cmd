@echo off
set JAVA_HOME=D:\D\SoloForge\bin\jdk-23-mini
set PATH=%JAVA_HOME%\bin;%PATH%
cd /d D:\D\SoloForge\solo-forge-agent
call mvnw.cmd -Dmaven.multiModuleProjectDirectory=D:\D\SoloForge\solo-forge-agent package -DskipTests
