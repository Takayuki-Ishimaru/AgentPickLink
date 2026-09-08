// Run against an extracted VSIX extension/ directory or an npm-installed package.
// Uses an isolated empty workspace and broker; never opens a browser or contacts Microsoft 365.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

assert.ok(process.argv[2], "Usage: npm run smoke:package -- <extracted-or-installed-package-directory>");
const packageRoot = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const cli = path.resolve(packageRoot, manifest.bin["m365-agent"]);
for (const file of [manifest.main, manifest.icon, "media/setup.js", "media/setup.css"]) {
  await access(path.resolve(packageRoot, file));
}
assert.deepEqual(await readdir(path.join(packageRoot, "dist/extension")), ["extension.cjs"]);
for (const file of await readdir(path.join(packageRoot, "dist"), { recursive: true })) {
  assert.ok(!file.endsWith(".map"), `Unexpected source map: ${file}`);
}
for (const directory of ["src", "tests", "brand", "output"]) {
  await assert.rejects(access(path.join(packageRoot, directory)), { code: "ENOENT" });
}
let license;
for (const name of ["LICENSE", "LICENSE.txt"]) {
  try {
    license = await readFile(path.join(packageRoot, name), "utf8");
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
assert.equal(manifest.license, "MIT");
assert.ok(
  license?.includes("MIT License") &&
    license.includes("Permission is hereby granted, free of charge") &&
    license.includes("OUT OF OR IN CONNECTION WITH THE SOFTWARE"),
  "Full MIT license must ship"
);
await access(path.join(packageRoot, "README.en.md"));
await access(path.join(packageRoot, "release-docs", "OSS-LICENSES.md"));
await access(path.join(packageRoot, "release-docs", "THIRD-PARTY-NOTICES.txt"));

const temporary = await mkdtemp(path.join(os.tmpdir(), "apl-package-smoke-"));
const appData = path.join(temporary, "unused-app-data");
// Pass an explicit environment so local development switches and user state cannot leak in.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|PSMODULEPATH)$/i.test(
        key
      )
  )
);
env.M365_AGENT_APP_DATA = appData;
// Exercise the Linux runtime explicitly; this does not change the supported-desktop policy.
if (process.platform === "linux") env.M365_AGENT_ALLOW_UNSUPPORTED_OS = "1";
const runCli = (...args) =>
  promisify(execFile)(process.execPath, [cli, ...args], {
    cwd: temporary,
    env,
    timeout: 15_000
  });
let brokerStarted = false;
let phase = "CLI version";
const clients = [
  new Client({ name: "release-package-smoke-a", version: manifest.version }),
  new Client({ name: "release-package-smoke-b", version: manifest.version })
];
const transports = clients.map(
  () =>
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve"],
      cwd: temporary,
      env,
      stderr: "pipe"
    })
);
const stderr = transports.map(() => "");
transports.forEach((transport, index) => {
  transport.stderr?.on("data", (chunk) => (stderr[index] += chunk));
});
const closeClient = async (client) => {
  try {
    await client.close();
  } catch {
    // A client that failed before initialize has no session to close.
  }
};
try {
  const { stdout } = await runCli("--version");
  assert.equal(stdout.trim(), manifest.version);
  phase = "MCP initialization";
  await Promise.all(clients.map((client, index) => client.connect(transports[index], { timeout: 15_000 })));
  for (const client of clients) {
    assert.match(client.getInstructions() ?? "", /Japanese\/CJK/);
    assert.match(client.getInstructions() ?? "", /transfer integrity/);
  }
  const toolResults = await Promise.all(clients.map((client) => client.listTools({}, { timeout: 15_000 })));
  for (const result of toolResults) {
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "m365_agent_ask",
      "m365_agent_list",
      "m365_agent_session"
    ]);
  }
  assert.equal(clients[0].getServerVersion()?.version, manifest.version);
  assert.equal(clients[1].getServerVersion()?.version, manifest.version);
  await assert.rejects(access(appData), { code: "ENOENT" });
  brokerStarted = true;
  phase = "concurrent cold broker startup";
  const startedAt = Date.now();
  const listedResults = await Promise.all(
    // Windows startup includes multiple real PowerShell ACL operations before the broker handshake.
    clients.map((client) =>
      client.callTool(
        { name: "m365_agent_list", arguments: {} },
        { timeout: process.platform === "win32" ? 120_000 : 30_000 }
      )
    )
  );
  process.stdout.write(`Concurrent cold broker startup: ${Date.now() - startedAt}ms\n`);
  for (const listed of listedResults) {
    assert.notEqual(listed.isError, true, JSON.stringify(listed));
    assert.deepEqual(listed.structuredContent.agents, []);
    assert.equal(listed.structuredContent.workspace.configured, false);
  }
  phase = "broker health";
  const health = JSON.parse((await runCli("--json", "broker", "status")).stdout);
  assert.equal(health.live, true);
  assert.equal(health.browserStarted, false);
  assert.equal(typeof health.instanceId, "string");
  await Promise.all(clients.map(closeClient));
  assert.deepEqual(stderr, ["", ""], "Packaged MCP startup must not emit errors");
} catch (error) {
  process.stderr.write(`Package smoke failed during ${phase}: ${JSON.stringify(stderr)}\n`);
  throw error;
} finally {
  await Promise.all(clients.map(closeClient));
  if (brokerStarted) {
    await runCli("--json", "broker", "stop");
    const deadline = Date.now() + 10_000;
    while (JSON.parse((await runCli("--json", "broker", "status")).stdout).live) {
      assert.ok(Date.now() < deadline, "Packaged broker did not shut down");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(`Package smoke passed: ${manifest.name}@${manifest.version} on ${process.version}\n`);
