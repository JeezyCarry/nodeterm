import { execFile } from 'child_process'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

/** Exact Windows console/process generation, not merely a reused PID or executable name. */
export function sameNativeProcess(before: PaneOwner | undefined, after: PaneOwner | null): boolean {
  return !!before && !!after && !!before.paneId && before.paneId === after.paneId &&
    before.panePid === after.panePid && before.tty === after.tty &&
    before.pids?.length === 1 && after.pids?.length === 1 &&
    before.pids[0] === after.pids[0] && !!before.processBirths?.[0] &&
    before.processBirths[0] === after.processBirths?.[0] &&
    before.argv?.[0] === after.argv[0]
}

/** Windows has no POSIX foreground process group. Require the native executable to be on
 * the same console, reached through ONE unambiguous shell/bootstrap chain. Never search
 * arbitrary descendants (an MCP server or a detached background agent is not the reader).
 * Console membership comes from GetConsoleProcessList; paths and birth times from CIM.
 * Raw-input readiness and verified idle hooks remain separate delivery gates. */
export interface WindowsConsoleProcess {
  pid: number
  parent: number
  executable: string
  born: string
}

export interface WindowsConsoleSnapshot {
  console: number[]
  processes: WindowsConsoleProcess[]
}

const SHELLS = new Set(['pwsh', 'powershell', 'cmd'])
function executableName(executable: string): string {
  return (executable.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')
}

export function windowsConsoleOwner(
  rootPid: number,
  generation: string,
  snapshot: WindowsConsoleSnapshot
): PaneOwner | null {
  const attached = new Set(snapshot.console)
  const rows = new Map(snapshot.processes.map((row) => [row.pid, row]))
  const root = rows.get(rootPid)
  if (!root || !attached.has(rootPid) || !root.born || !generation) return null
  const seen = new Set<number>()
  let current = root
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current.pid) || !attached.has(current.pid) || !current.executable || !current.born) return null
    seen.add(current.pid)
    const binary = executableName(current.executable)
    if (!binary) return null
    if (SHELLS.has(binary)) {
      // Count ALL children: ignoring a detached sibling would hide an ambiguous shell.
      const children = snapshot.processes.filter((row) => row.parent === current.pid)
      if (children.length > 1) return null
      if (children.length === 1) {
        const child = children[0]
        if (child.born < current.born) return null // recycled parent PID
        current = child
        continue
      }
    }
    return {
      panePid: rootPid,
      tty: `win32-console:${rootPid}`,
      paneId: `win32:${generation}:${root.born}`,
      command: binary,
      // Deliberately derived from the OS executable path, NOT arguments/prompt text.
      argv: [binary],
      pids: [current.pid],
      processBirths: [current.born]
    }
  }
  return null
}

/** Probe only. The helper joins the console to read its process list, writes nothing into
 * it, and detaches in finally. The target PID is a validated integer, never shell text.
 * Do not log stdout: the result is an internal identity read. */
export function windowsConsoleProbeScript(rootPid: number): string {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('invalid console root PID')
  return `$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NtConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint length); }';
$self = $PID; $ids = @();
try {
  [void][NtConsoleProbe]::FreeConsole();
  if (-not [NtConsoleProbe]::AttachConsole(${rootPid})) { throw 'console unavailable' };
  $buffer = New-Object 'System.UInt32[]' 1024;
  $count = [NtConsoleProbe]::GetConsoleProcessList($buffer, $buffer.Length);
  if ($count -eq 0 -or $count -gt $buffer.Length) { throw 'console identity unavailable' };
  for ($i = 0; $i -lt $count; $i++) { if ($buffer[$i] -ne $self) { $ids += [int]$buffer[$i] } };
} finally { [void][NtConsoleProbe]::FreeConsole() };
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self } | ForEach-Object {
  @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; executable = [string]$_.ExecutablePath; born = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) }
});
@{ console = @($ids); processes = $rows } | ConvertTo-Json -Depth 4 -Compress;`
}

export async function readWindowsConsoleOwner(rootPid: number, generation: string): Promise<PaneOwner | null> {
  if (process.platform !== 'win32') return null
  const script = windowsConsoleProbeScript(rootPid)
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null)
        try {
          const snapshot = JSON.parse(stdout) as WindowsConsoleSnapshot
          if (!Array.isArray(snapshot.console) || !Array.isArray(snapshot.processes)) return resolve(null)
          resolve(windowsConsoleOwner(rootPid, generation, snapshot))
        } catch { resolve(null) }
      })
  })
}
