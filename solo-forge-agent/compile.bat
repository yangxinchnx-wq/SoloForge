@echo off
set "JAVA_HOME=C:\Users\yangx\Java\jdk-23.0.1"
set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"
cd /d c:\Users\yangx\Desktop\SoloForge\solo-forge-agent
set "MAVEN_PROJECTBASEDIR=c:\Users\yangx\Desktop\SoloForge\solo-forge-agent"
set "CLASSPATH=%MAVEN_PROJECTBASEDIR%\.mvn\wrapper\maven-wrapper.jar"
"%JAVA_EXE%" -Dmaven.multiModuleProjectDirectory="%MAVEN_PROJECTBASEDIR%" -classpath "%CLASSPATH%" org.apache.maven.wrapper.MavenWrapperMain compile -q -DskipTests
