import { execFile } from "node:child_process";

/** These scripts receive all input through argv; close the otherwise-open stdin pipe. */
export function executePowerShell(
  script: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      }
    );
    child.stdin?.end();
  });
}
