import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildAgyEnvironment } from './agy-environment';
import type { AcpChildProcess } from './acp-types';

// Pin the actual process handles. The job then tracks descendants in the kernel,
// including workers whose immediate parent exits before Gravity closes stdin.
const jobSource = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class GravityAcpJob {
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint processLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int length, IntPtr used);
  [DllImport("kernel32", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  static Dictionary<int,int> Parents() {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var entry = new Entry();
      entry.size = (uint)Marshal.SizeOf(entry);
      var result = new Dictionary<int,int>();
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
      do { result[(int)entry.pid] = (int)entry.parent; } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
      return result;
    } finally { CloseHandle(snapshot); }
  }
  static void Adopt(List<IntPtr> jobs, Process process) {
    foreach (IntPtr existing in jobs) {
      bool inside;
      if (!IsProcessInJob(process.Handle, existing, out inside)) throw new Win32Exception();
      if (inside) return;
    }
    // A child already in a different inherited job hierarchy needs its own nested job.
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    jobs.Add(job);
    var limits = new Limits(); limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, process.Handle) && !process.HasExited) throw new Win32Exception();
  }
  static uint Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return info.active;
  }
  public static void Watch(int pid, int host, long earliest, long latest) {
    using (Process root = Process.GetProcessById(pid)) {
      IntPtr handle = root.Handle;
      DateTime birth = root.StartTime.ToUniversalTime();
      long ms = new DateTimeOffset(birth).ToUnixTimeMilliseconds();
      int parent;
      if (ms < earliest || ms > latest || !Parents().TryGetValue(pid, out parent) || parent != host) throw new InvalidOperationException();
      var jobs = new List<IntPtr>();
      try {
        Adopt(jobs, root);
        // Adopt any children created during startup, before the root joined the job.
        var queue = new Queue<Process>();
        var pinned = new List<Process>();
        queue.Enqueue(root);
        try {
          while (queue.Count > 0) {
            var ancestor = queue.Dequeue();
            var parents = Parents();
            foreach (var row in parents) {
              if (row.Value != ancestor.Id || row.Key == ancestor.Id) continue;
              Process child;
              try { child = Process.GetProcessById(row.Key); } catch (ArgumentException) { continue; }
              pinned.Add(child);
              try {
                IntPtr childHandle = child.Handle;
                var childBirth = child.StartTime.ToUniversalTime();
                if (childBirth < ancestor.StartTime.ToUniversalTime() ||
                    (ancestor.HasExited && childBirth > ancestor.ExitTime.ToUniversalTime())) continue;
                Adopt(jobs, child);
                queue.Enqueue(child);
              } catch (InvalidOperationException) { if (!child.HasExited) throw; }
            }
          }
        } finally { foreach (Process child in pinned) child.Dispose(); }
        Console.WriteLine("ready");
        while (true) {
          string command = Console.ReadLine();
          if (command != "stop" && command != null) continue;
          foreach (IntPtr job in jobs) if (Active(job) != 0 && !TerminateJobObject(job, 1)) throw new Win32Exception();
          var wait = Stopwatch.StartNew();
          while (jobs.Exists(job => Active(job) != 0) && wait.ElapsedMilliseconds < 1800) System.Threading.Thread.Sleep(15);
          if (!jobs.Exists(job => Active(job) != 0)) { Console.WriteLine("empty"); return; }
          if (command == null) throw new TimeoutException();
          Console.WriteLine("busy");
        }
      } finally { foreach (IntPtr job in jobs) { TerminateJobObject(job, 1); CloseHandle(job); } }
    }
  }
}`;

export class WindowsAcpTree {
  readonly ready: Promise<void>;
  private waiters = new Set<(line: string) => void>();
  private failed = false;
  private empty = false;
  private readonly helper;

  constructor(private child: AcpChildProcess, pid: number, earliest: number, latest: number) {
    const command = "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" + jobSource +
      "\n'@\n[GravityAcpJob]::Watch(" + [pid, process.pid, earliest, latest].join(',') + ")";
    const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    this.helper = spawn(binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: buildAgyEnvironment(binary),
    });
    const report = (line: string) => {
      if (line === 'empty') this.empty = true;
      if (line === 'failed') this.failed = true;
      for (const waiter of [...this.waiters]) waiter(line);
    };
    createInterface({ input: this.helper.stdout }).on('line', report);
    this.helper.once('error', () => report('failed'));
    this.helper.once('close', () => { if (!this.empty) report('failed'); });
    this.helper.stdin.on('error', () => { if (!this.empty) report('failed'); });
    this.ready = this.wait('ready', 30_000).catch(error => {
      this.child.stdin?.end();
      this.helper.stdin.end();
      throw error;
    });
  }

  private wait(expected: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const complete = (line: string) => {
        if (line !== expected && line !== 'failed' && line !== 'busy') return;
        this.waiters.delete(complete);
        clearTimeout(timer);
        if (line === expected) resolve();
        else reject(new Error('无法确认本实例 Windows ACP 进程树已回收，请重试关闭'));
      };
      const timer = setTimeout(() => complete('failed'), timeout);
      this.waiters.add(complete);
      if (this.failed) complete('failed');
    });
  }

  async close(): Promise<void> {
    if (this.empty) return;
    await this.ready;
    if (this.child.exitCode == null && this.child.signalCode == null) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.child.off('exit', done); resolve(); };
        const timer = setTimeout(done, 700);
        this.child.once('exit', done);
        this.child.stdin?.end();
      });
    }
    const barrier = this.wait('empty', 2500);
    this.helper.stdin.write('stop\n');
    await barrier;
    this.helper.stdin.end();
  }
}
