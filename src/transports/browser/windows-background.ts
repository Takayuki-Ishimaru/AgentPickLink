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
  public static bool Hide(uint processId) {
    bool hidden = true;
    bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == processId && IsWindowVisible(window)) {
        ShowWindow(window, 0);
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
