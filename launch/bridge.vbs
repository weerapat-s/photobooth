Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\launcher.ps1"" -Mode bridge", 0, False

' เปิด Cloudflare Tunnel แบบซ่อนหน้าต่างเมื่อมี config แล้ว และกันการเปิดซ้ำ
localAppData = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
cloudflared = localAppData & "\PhotoBooth\bin\cloudflared.exe"
configFile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cloudflared\config.yml"
logFile = fso.GetParentFolderName(here) & "\logs\tunnel.log"

If fso.FileExists(cloudflared) And fso.FileExists(configFile) Then
  tunnelRunning = False
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  For Each process In wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='cloudflared.exe'")
    If Not IsNull(process.CommandLine) Then
      If InStr(1, process.CommandLine, configFile, vbTextCompare) > 0 Then tunnelRunning = True
    End If
  Next
  If Not tunnelRunning Then
    sh.Run """" & cloudflared & """ tunnel --config """ & configFile & """ --logfile """ & logFile & """ --loglevel info run", 0, False
  End If
End If
