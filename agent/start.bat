@echo off
rem Starts the agent hidden via agent.vbs (no console window).
rem Pair first:  node src\index.js pair
wscript.exe "%~dp0agent.vbs"
