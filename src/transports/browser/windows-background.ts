import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserTransportError } from "./types.js";

const execFileAsync = promisify(execFile);

/** Only the PID obtained from this broker's browser CDP connection is eligible. No title,
 * executable-name search, desktop-wide hiding, policy bypass or elevation is used. */
export async function hideBrowserWindows(browserPid: number): Promise<void> {
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0 || browserPid > 0xffffffff)
    throw backgroundWindowFailure();
  const script = `$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AplWindowVisibility {
  private delegate bool EnumWindowProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")]
  private static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW")]
  private static extern int SetWindowLong(IntPtr window, int index, int value);
  [DllImport("user32.dll")]
  private static extern bool SetLayeredWindowAttributes(IntPtr window, uint color, byte alpha, uint flags);
  [DllImport("user32.dll")]
  private static extern bool GetLayeredWindowAttributes(IntPtr window, out uint color, out byte alpha, out uint flags);
  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  public static bool Hide(uint processId) {
    bool hidden = true;
    bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == processId && IsWindowVisible(window)) {
        // Hide before changing window styles. Chromium explicitly shows its
        // window for new background tabs. Keep its subsequent shows transparent, non-activating
        // and outside the virtual desktop, including browser-owned download popups.
        // Relinquish foreground ownership before removing the sign-in window. SW_HIDE alone
        // can leave keyboard focus assigned to the now invisible Edge window on Windows.
        if (GetForegroundWindow() == window) ShowWindow(window, 6);
        ShowWindow(window, 0);
        const int required = 0x00080000 | 0x08000000 | 0x00000080;
        int style = (GetWindowLong(window, -20) | required) & ~0x00040000;
        SetWindowLong(window, -20, style);
        uint color, flags;
        byte alpha;
        int outside = GetSystemMetrics(76) + GetSystemMetrics(78) + 1024;
        if ((GetWindowLong(window, -20) & required) != required ||
            !SetLayeredWindowAttributes(window, 0, 0, 2) ||
            !GetLayeredWindowAttributes(window, out color, out alpha, out flags) ||
            alpha != 0 || (flags & 2) == 0 ||
            !SetWindowPos(window, IntPtr.Zero, outside, GetSystemMetrics(77), 0, 0, 0x0035)) hidden = false;
        if (IsWindowVisible(window)) hidden = false;
      }
      return true;
    }, IntPtr.Zero);
    return enumerated && hidden;
  }
}
'@
if (![AplWindowVisibility]::Hide([uint32]${browserPid})) { throw 'APL_HIDE_FAILED' }
Write-Output 'APL_WINDOWS_HIDDEN'
} catch { Write-Output 'APL_HIDE_FAILED'; exit 1 }
`;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: 15_000
      }
    );
    if (!result.stdout.includes("APL_WINDOWS_HIDDEN")) throw backgroundWindowFailure();
  } catch {
    // Native stderr can contain environment details. Preserve no raw process output.
    throw backgroundWindowFailure();
  }
}

export function backgroundWindowFailure(): BrowserTransportError {
  return new BrowserTransportError(
    "BROWSER_START_FAILED",
    "AgentPickLink could not hide its dedicated browser window while retaining the signed-in session.",
    "Retry setup. If this persists, copy the diagnostics. Windows must allow PowerShell to control AgentPickLink's own browser window; do not change your organization's sign-in policy."
  );
}
