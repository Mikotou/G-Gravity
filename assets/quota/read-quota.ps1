# The official status line requires a terminal. Give this short-lived CLI its own
# hidden console without inheriting Electron's redirected standard handles.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class GravityQuotaConsole {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x, y, width, height, cols, rows, attr, flags;
    public short show, size; public IntPtr extra, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Child { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CreateProcessW(string file, StringBuilder cmd, IntPtr proc, IntPtr thread,
    bool inherit, uint flags, IntPtr env, string dir, ref Startup start, out Child child);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr process, uint ms);
  public static IntPtr Start(string file, string command, string dir) {
    var s = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = 1, show = 0 };
    Child c;
    if (!CreateProcessW(file, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x10,
         IntPtr.Zero, dir, ref s, out c)) throw new Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(c.thread); return c.process;
  }
}
"@
$handle = [GravityQuotaConsole]::Start($env:GRAVITY_QUOTA_BINARY, $env:GRAVITY_QUOTA_COMMAND, $env:GRAVITY_QUOTA_CWD)
try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.Elapsed.TotalSeconds -lt [int]$env:GRAVITY_QUOTA_WAIT) {
    if ([IO.File]::Exists($env:GRAVITY_QUOTA_RESULT)) {
      try {
        $record = [IO.File]::ReadAllText($env:GRAVITY_QUOTA_RESULT) | ConvertFrom-Json
        if (@($record.quota.PSObject.Properties).Count -gt 0 -and $record.quota) { exit 0 }
      } catch { }
    }
    if ([GravityQuotaConsole]::WaitForSingleObject($handle, 160) -eq 0) { break }
  }
  exit 2
} finally {
  if ([GravityQuotaConsole]::WaitForSingleObject($handle, 0) -ne 0) {
    [void][GravityQuotaConsole]::TerminateProcess($handle, 0)
    [void][GravityQuotaConsole]::WaitForSingleObject($handle, 1000)
  }
  [void][GravityQuotaConsole]::CloseHandle($handle)
}
