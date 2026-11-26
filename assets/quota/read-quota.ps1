# The official status line needs a console. Only this invocation's CLI and its
# descendants enter the unnamed job. Closing its one handle releases the process tree.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class GravityQuotaConsole : IDisposable {
  private const uint NewConsole = 0x10;
  private const uint ExtendedStartupInfo = 0x80000;
  private const uint KillOnJobClose = 0x2000;
  private const int ExtendedJobLimits = 9;
  private static readonly IntPtr JobListAttribute = new IntPtr(0x2000D);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct Startup {
    public int size;
    public string reserved, desktop, title;
    public int x, y, width, height, cols, rows, attributes, flags;
    public short showWindow, reservedSize;
    public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedStartup { public Startup startup; public IntPtr attributeList; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Child { public IntPtr process, thread; public int processId, threadId; }
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet;
    public uint processLimit;
    public UIntPtr affinity;
    public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JobLimits {
    public BasicLimits basic;
    public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr CreateJobObjectW(IntPtr security, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value,
    IntPtr bytes, IntPtr previous, IntPtr returnedBytes);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern bool CreateProcessW(string file, StringBuilder cmd, IntPtr security, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string directory, ref ExtendedStartup start, out Child child);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint ms);

  private IntPtr job, process;
  private GravityQuotaConsole() { }

  public static GravityQuotaConsole Start(string file, string command, string directory) {
    var owner = new GravityQuotaConsole();
    IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero, bytes = IntPtr.Zero;
    bool initialized = false;
    try {
      owner.job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      if (owner.job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      var limits = new JobLimits();
      limits.basic.flags = KillOnJobClose;
      if (!SetInformationJobObject(owner.job, ExtendedJobLimits, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());

      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
      if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributes = Marshal.AllocHGlobal(bytes);
      if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      initialized = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobValue, owner.job);
      if (!UpdateProcThreadAttribute(attributes, 0, JobListAttribute, jobValue, new IntPtr(IntPtr.Size),
          IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());

      // Assign at creation: a timeout that terminates this host cannot strand an unassigned child.
      var start = new ExtendedStartup();
      start.attributeList = attributes;
      start.startup.size = Marshal.SizeOf(typeof(ExtendedStartup));
      start.startup.flags = 1; // STARTF_USESHOWWINDOW, SW_HIDE
      Child child;
      if (!CreateProcessW(file, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
          NewConsole | ExtendedStartupInfo, IntPtr.Zero, directory, ref start, out child))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      owner.process = child.process;
      CloseHandle(child.thread);
      return owner;
    } catch {
      owner.Dispose();
      throw;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
    }
  }

  public bool Exited(uint milliseconds) {
    uint status = WaitForSingleObject(process, milliseconds);
    if (status == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
    return status == 0;
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (process != IntPtr.Zero) {
      WaitForSingleObject(process, 1000);
      CloseHandle(process);
      process = IntPtr.Zero;
    }
  }
}
"@
$probe = [GravityQuotaConsole]::Start($env:GRAVITY_QUOTA_BINARY, $env:GRAVITY_QUOTA_COMMAND, $env:GRAVITY_QUOTA_CWD)
try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $exited = $false
  while ($true) {
    if ([IO.File]::Exists($env:GRAVITY_QUOTA_RESULT)) {
      try {
        $record = [IO.File]::ReadAllText($env:GRAVITY_QUOTA_RESULT) | ConvertFrom-Json
        if ($record.buckets.Count -gt 0 -or ($record.quota -and @($record.quota.PSObject.Properties).Count -gt 0)) { exit 0 }
      } catch { }
    }
    # A fast-exiting CLI can publish a final file during the wait. Check it once more.
    if ($exited -or $timer.Elapsed.TotalSeconds -ge [int]$env:GRAVITY_QUOTA_WAIT) { break }
    $exited = $probe.Exited(160)
  }
  if ($exited) { exit 1 }
  exit 2
} finally {
  $probe.Dispose()
}
