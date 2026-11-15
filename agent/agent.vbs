' Launches the agent hidden (no console window). Used by start.bat and Task Scheduler.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
' Run node hidden: 0 = hidden window, False = do not wait for exit
shell.Run "cmd /c node src\index.js run", 0, False
