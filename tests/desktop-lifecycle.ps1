param([int]$ExistingProcessId, [switch]$Crash)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopCloseProbe {
    public delegate bool Callback(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public static bool Close(int pid) {
        bool sent = false;
        EnumWindows((handle, state) => {
            uint owner; GetWindowThreadProcessId(handle, out owner);
            var text = new StringBuilder(256); GetWindowText(handle, text, text.Capacity);
            if (owner == pid && text.ToString() == "OBS Karaoke MVP") {
                sent = PostMessage(handle, 0x10, IntPtr.Zero, IntPtr.Zero);
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return sent;
    }
}
'@
$appProcess = Get-Process -Id $ExistingProcessId
$allProcesses = Get-CimInstance Win32_Process
$ownedIds = @($ExistingProcessId)
do {
    $found = @($allProcesses | Where-Object { $_.ParentProcessId -in $ownedIds -and $_.ProcessId -notin $ownedIds } | Select-Object -ExpandProperty ProcessId)
    $ownedIds += $found
} while ($found.Count -gt 0)
$watch = [Diagnostics.Stopwatch]::StartNew()
if ($Crash) { Stop-Process -Id $ExistingProcessId -Force } else {
    if (-not [DesktopCloseProbe]::Close($ExistingProcessId)) { throw 'Main window was not found.' }
}
if (-not $appProcess.WaitForExit(12000)) { throw 'Launcher did not exit.' }
do {
    $remaining = @(Get-Process -Id $ownedIds -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 0) { Start-Sleep -Milliseconds 100 }
} while ($remaining.Count -gt 0 -and $watch.ElapsedMilliseconds -lt 15000)
[pscustomobject]@{Mode=$(if($Crash){'crash'}else{'window-close'});OwnedProcesses=$ownedIds.Count;Remaining=$remaining.Count;ElapsedMs=$watch.ElapsedMilliseconds} | ConvertTo-Json
if ($remaining.Count -gt 0) { throw "Owned processes remained: $($remaining.Id -join ',')" }
