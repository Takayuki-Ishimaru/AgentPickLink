import type { HostMessage } from "../../src/services/setup-protocol.js";
import type { AgentCandidate } from "../../src/services/setup-service.js";
import type { CommandDeps } from "../../src/cli/command-deps.js";
import { request } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSetupServer, SETUP_LIFETIME_MS, type SetupServer } from "../../src/cli/setup-server/server.js";
import { BrowserSetupHost, pollSetupHealth } from "../../src/cli/setup-server/browser-host.js";
import { makeCommandDeps, makeScriptedPrompter, makeTempPaths } from "./helpers.js";
import { defaultGlobalConfig } from "../../src/config/global-config.js";

const servers: SetupServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function setup() {
  const messages = vi.fn(async () => undefined);
  const expired = vi.fn();
  let expire!: () => void;
  let lifetime = 0;
  const cancel = vi.fn();
  const server = await startSetupServer({
    mediaDirectory: path.resolve("media"),
    onMessage: messages,
    onExpired: expired,
    schedule: (callback, ms) => {
      expire = callback;
      lifetime = ms;
      return cancel;
    }
  });
  servers.push(server);
  const origin = new URL(server.url).origin;
  const page = await fetch(server.url);
  const html = await page.text();
  const token = /window.aplSession="([a-f0-9]+)"/.exec(html)![1];
  const headers = { "X-APL-Session": token, Origin: origin, "Content-Type": "application/json" };
  return { server, origin, page, html, headers, messages, expire, expired, lifetime, cancel };
}
describe("browser setup transport", () => {
  it("binds IPv4 loopback, consumes the path once, and serves nonce-only CSP without cookies", async () => {
    const ctx = await setup();
    expect(new URL(ctx.origin).hostname).toBe("127.0.0.1");
    expect(ctx.page.status).toBe(200);
    expect((await fetch(ctx.server.url)).status).toBe(403);
    const csp = ctx.page.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(ctx.html).toContain(`<script nonce="${nonce}">`);
    expect(ctx.html).toContain(`<style nonce="${nonce}">`);
    expect(ctx.page.headers.get("cache-control")).toBe("no-store");
    expect(ctx.page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ctx.page.headers.get("set-cookie")).toBeNull();
  });

  // ISSUE-07: setup.css's `.header-row` keeps an 18px `.brand-mark` column even once
  // setup-standalone.css hides that mark, leaving so little room for the title on the standalone
  // page that it wraps one character per line. media/setup-standalone.css is served after
  // media/setup.css in the same <style> block, so its single-column override (and the matching
  // `.dev`/h2 re-pointing away from the now-nonexistent column 2) must actually reach the page.
  it("serves setup-standalone.css's single-column header-row override after setup.css's own", async () => {
    const ctx = await setup();
    const setupCssIndex = ctx.html.indexOf("grid-template-columns: 18px minmax(0, 1fr);");
    const standaloneOverrideIndex = ctx.html.indexOf("grid-template-columns: minmax(0, 1fr);");
    expect(setupCssIndex).toBeGreaterThan(-1);
    expect(standaloneOverrideIndex).toBeGreaterThan(setupCssIndex);
    expect(ctx.html).toContain(".header-row h2,\n.header-row .dev {\n  grid-column: 1 / -1;\n}");
  });
  it("requires the session header and exact origin, refuses every preflight, and validates messages", async () => {
    const ctx = await setup();
    for (const headers of [
      {},
      { ...ctx.headers, "X-APL-Session": "x" },
      { ...ctx.headers, Origin: "https://example.invalid" }
    ]) {
      expect(
        (await fetch(`${ctx.origin}/message`, { method: "POST", headers, body: '{"type":"ready"}' })).status
      ).toBe(403);
    }
    expect((await fetch(`${ctx.origin}/events`)).status).toBe(403);
    const preflight = await fetch(`${ctx.origin}/message`, { method: "OPTIONS", headers: ctx.headers });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      (
        await fetch(`${ctx.origin}/message`, {
          method: "POST",
          headers: ctx.headers,
          body: '{"type":"approve"}'
        })
      ).status
    ).toBe(400);
    expect(
      (
        await fetch(`${ctx.origin}/message`, {
          method: "POST",
          headers: ctx.headers,
          body: '{"type":"ready"}'
        })
      ).status
    ).toBe(204);
    expect(ctx.messages).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
  });
  it("rejects a mismatched Host even with the session token", async () => {
    const ctx = await setup();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${ctx.origin}/events`,
        { headers: { ...ctx.headers, Host: "localhost" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
  it("has one SSE stream and a hard non-renewing fifteen-minute deadline", async () => {
    const ctx = await setup();
    expect(ctx.lifetime).toBe(SETUP_LIFETIME_MS);
    const events = await fetch(`${ctx.origin}/events`, { headers: ctx.headers });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect((await fetch(`${ctx.origin}/events`, { headers: ctx.headers })).status).toBe(409);
    ctx.server.send({ type: "terminal", text: "confirm in terminal" });
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ctx.expire();
    expect(ctx.server.active()).toBe(false);
    expect(ctx.expired).toHaveBeenCalledOnce();
    expect(ctx.cancel).toHaveBeenCalledOnce();
    await reader.cancel();
    await expect(fetch(`${ctx.origin}/events`, { headers: ctx.headers })).rejects.toThrow();
  });
  it("refuses oversized request bodies without dispatching", async () => {
    const ctx = await setup();
    const result = await fetch(`${ctx.origin}/message`, {
      method: "POST",
      headers: ctx.headers,
      body: "x".repeat(65_537)
    });
    expect(result.status).toBe(413);
    expect(ctx.messages).not.toHaveBeenCalled();
  });
});

describe("browser setup terminal boundary", () => {
  it.each(["agents", "widening"] as const)(
    "keeps %s consent in the terminal even with approval flags",
    async (kind) => {
      const paths = await makeTempPaths();
      const prompter = makeScriptedPrompter({ interactive: true, confirmAnswer: false });
      const { deps } = makeCommandDeps({ paths, prompter });
      const host = new BrowserSetupHost(
        {
          locale: "ja",
          version: "1.2.3",
          paths,
          installHome: path.join(paths.root, "install"),
          platform: process.platform,
          workspaceRoot: path.join(paths.root, "ws"),
          brokerEntry: "unused",
          out: () => undefined,
          prompter,
          env: deps.env,
          homedir: deps.homedir,
          yes: true,
          approveAgents: true,
          allowActionsPossible: true
        },
        defaultGlobalConfig(paths.profile).clients,
        deps
      );
      const send = vi.fn();
      host.server = { url: "", active: () => true, send, close: async () => undefined };
      expect(
        await host.confirm({ title: "Confirm", confirmLabel: "Approve", kind, severity: "warning" })
      ).toBe(false);
      expect(prompter.confirmCalls).toEqual(["Approve"]);
      expect(send).toHaveBeenCalledWith({ type: "terminal", text: "端末で確認してください。" });
    }
  );
  it("keeps shared candidate keys stable and rejects consent after expiry", async () => {
    const paths = await makeTempPaths();
    let active = true;
    const prompter = makeScriptedPrompter({ interactive: true });
    const { deps } = makeCommandDeps({ paths, prompter });
    const host = new BrowserSetupHost(
      {
        locale: "en",
        version: "1.2.3",
        paths,
        installHome: path.join(paths.root, "install"),
        platform: process.platform,
        workspaceRoot: paths.root,
        brokerEntry: "unused",
        out: () => undefined,
        prompter,
        env: deps.env,
        homedir: deps.homedir
      },
      defaultGlobalConfig(paths.profile).clients,
      deps
    );
    const send = vi.fn();
    host.server = { url: "", active: () => active, send, close: async () => undefined };
    const candidate: AgentCandidate = {
      key: "https://example.invalid/agent",
      url: "https://example.invalid/agent",
      displayName: "Example",
      surface: "m365-copilot",
      source: "registry",
      assigned: true
    };
    host.post({
      type: "state",
      state: {
        phase: "selecting",
        candidates: [candidate, candidate],
        selectedKeys: [candidate.key],
        warnings: [],
        diagnostics: [],
        incidents: [],
        locale: "en",
        version: "1.2.3",
        integrations: { codex: false, claudeCode: false, vscodeMcpJson: false }
      }
    });
    const sent = send.mock.calls[0][0] as HostMessage;
    const opaque = sent.state.candidates[0].key;
    expect(sent.state.selectedKeys).toEqual([opaque]);
    expect(opaque).not.toBe(candidate.key);
    expect(sent.state.candidates[1].key).toBe(opaque);
    expect(sent.state.candidates[0].url).toBe("");
    expect(candidate.url).toBe(candidate.key);
    expect(host.restoreMessage({ type: "unregisterAgent", key: opaque })).toEqual({
      type: "unregisterAgent",
      key: candidate.key
    });
    prompter.confirm = async () => {
      active = false;
      return true;
    };
    expect(
      await host.confirm({ title: "Confirm", confirmLabel: "Approve", kind: "agents", severity: "warning" })
    ).toBe(false);
  });
  it("polls only an existing broker and disposes the IPC connection", async () => {
    const paths = await makeTempPaths();
    const close = vi.fn();
    const connect = vi.fn(async () => ({ call: async () => ({ browserStarted: false }), close }));
    const { deps } = makeCommandDeps({
      paths,
      connectExistingBroker: connect as unknown as CommandDeps["connectExistingBroker"]
    });
    const listener = vi.fn();
    const poller = pollSetupHealth(deps, listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    poller.dispose();
    expect(close).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe("BrowserSetupHost ISSUE-08: initial integration flags reflect the --clients selection", () => {
  async function makeHost(
    initialIntegrationFlags?: import("../../src/services/setup-protocol.js").IntegrationFlags
  ) {
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });
    const host = new BrowserSetupHost(
      {
        locale: "en",
        version: "1.2.3",
        paths,
        installHome: path.join(paths.root, "install"),
        platform: process.platform,
        workspaceRoot: paths.root,
        brokerEntry: "unused",
        out: () => undefined,
        prompter: makeScriptedPrompter({ interactive: true }),
        env: deps.env,
        homedir: deps.homedir
      },
      // config.yaml's own saved default -- every client off -- so a test can tell the two apart.
      defaultGlobalConfig(paths.profile).clients,
      deps,
      initialIntegrationFlags
    );
    return host;
  }

  it("uses install's --clients selection (VS Code=vscodeWorkspace, Claude Code=claudeProject, Codex=codex), not config.yaml's saved default", async () => {
    const host = await makeHost({ codex: true, claudeCode: true, vscodeMcpJson: false });
    expect(host.integrationFlags()).toEqual({ codex: true, claudeCode: true, vscodeMcpJson: false });
  });

  it("falls back to config.yaml's default when constructed without a CLI selection", async () => {
    const host = await makeHost(undefined);
    expect(host.integrationFlags()).toEqual({ codex: false, claudeCode: false, vscodeMcpJson: false });
  });
});
