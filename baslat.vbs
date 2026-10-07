' Birlikte Izle baslatici: sunucu calismiyorsa arka planda baslatir, sonra paneli acar.
Option Explicit

Dim shell, fso, dir, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Function Ping()
  Dim http
  Ping = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", "http://127.0.0.1:7301/api/ping", False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then Ping = True
  End If
  On Error GoTo 0
End Function

If Not Ping() Then
  If Not fso.FolderExists(dir & "\node_modules") Then
    MsgBox "Once kurulum.bat dosyasini calistir.", vbExclamation, "Birlikte Izle"
    WScript.Quit 1
  End If
  If Not fso.FolderExists(dir & "\data\logs") Then
    If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder dir & "\data"
    fso.CreateFolder dir & "\data\logs"
  End If
  shell.CurrentDirectory = dir
  shell.Run "cmd /c node server.js >> data\logs\stdout.log 2>&1", 0, False
  For i = 1 To 30
    WScript.Sleep 500
    If Ping() Then Exit For
  Next
  If Not Ping() Then
    MsgBox "Sunucu baslatilamadi. Ayrintilar: data\logs\stdout.log", vbCritical, "Birlikte Izle"
    WScript.Quit 1
  End If
End If

' Panel already open: bring it to the front instead of opening a second panel window.
' The panel is the Edge browser process started with our own profile folder and --app
' (its helper processes carry --type=, the window belongs to the main one).
Dim wmi, proc, cmdLine
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
  For Each proc In wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe'")
    cmdLine = "" & proc.CommandLine
    If InStr(1, cmdLine, dir & "\data\edge-panel", vbTextCompare) > 0 And InStr(cmdLine, "--app=") > 0 And InStr(cmdLine, "--type=") = 0 Then
      shell.AppActivate proc.ProcessId
      WScript.Quit 0
    End If
  Next
End If
Err.Clear

' Panel in the Birlikte Izle Motor app's own window instead of Edge (scripts\panel-ac.mjs).
' Exit code 1 = app not found: fall back to Edge below.
shell.CurrentDirectory = dir
If shell.Run("cmd /c node scripts\panel-ac.mjs", 0, True) = 0 Then WScript.Quit 0
Err.Clear

' Separate, empty profile: no extensions, and Edge exits when the window closes.
shell.Run "msedge --app=http://127.0.0.1:7301/ --window-size=1200,860 --user-data-dir=""" & dir & "\data\edge-panel"" --no-first-run --no-default-browser-check", 1, False
If Err.Number <> 0 Then
  Err.Clear
  shell.Run "http://127.0.0.1:7301/", 1, False
End If
