import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApprovalStoreSchema,
  GlobalConfigSchema,
  RegistrySchema,
  toDocumentedJsonSchema
} from "../../src/config/schema.js";
import { DEFAULT_APP_HOSTS, DEFAULT_AUTH_HOSTS, DEFAULT_DOWNLOAD_HOSTS } from "../../src/config/defaults.js";
import { WorkspaceConfigSchema } from "../../src/domain/workspace.js";
import { migrateStore, type StoreKind } from "../../src/config/migrations.js";
import { DomainError } from "../../src/domain/errors.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("strict configuration schemas", () => {
  it("rejects unknown security fields, wildcard hosts, duplicate capabilities, and unknown capabilities", () => {
    expect(
      GlobalConfigSchema.safeParse({ version: 1, browser: { profilePath: "C:\\profile" }, extra: true })
        .success
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        navigation: { appHosts: ["*.example.com"], authHosts: [] }
      }).success
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        security: { allowedCapabilityClasses: ["actions-possible", "actions-possible"] }
      }).success
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        security: { allowedCapabilityClasses: ["unknown"] }
      }).success
    ).toBe(false);
    // Download hosts, unlike the navigation hosts, accept a `*.` wildcard suffix -- but only as the
    // whole leftmost label, and only on a domain of at least two labels (src/domain/host-pattern.ts).
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        navigation: { appHosts: [], authHosts: [], downloadHosts: ["*.sharepoint.com", "onedrive.live.com"] }
      }).success
    ).toBe(true);
    for (const bad of [
      "*.com",
      "*sharepoint.com",
      "contoso.*.com",
      "*.sharepoint.com/x",
      "*.sharepoint.com:443"
    ])
      expect(
        GlobalConfigSchema.safeParse({
          version: 1,
          browser: { profilePath: "C:\\profile" },
          navigation: { appHosts: [], authHosts: [], downloadHosts: [bad] }
        }).success,
        bad
      ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        navigation: { appHosts: [], authHosts: ["*.microsoftonline.com"], downloadHosts: [] }
      }).success
    ).toBe(false);
  });
  it("rejects duplicate aliases, malformed fingerprints, and unknown workspace fields", () => {
    expect(
      WorkspaceConfigSchema.safeParse({ version: 1, agents: [{ alias: "good", selector: "textarea" }] })
        .success
    ).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse({ version: 1, agents: [{ alias: "same" }, { alias: "same" }] }).success
    ).toBe(false);
    expect(
      RegistrySchema.safeParse({
        version: 1,
        agents: [{ alias: "bad", verification: { bindingFingerprint: "raw" } }]
      }).success
    ).toBe(false);
    expect(
      ApprovalStoreSchema.safeParse({
        version: 1,
        approvals: [
          {
            workspaceKey: "bad",
            approvedBindings: [],
            approvedConfigDigest: "bad",
            approvedAt: new Date().toISOString(),
            approvalVersion: 1
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("browser/navigation defaults (docs/ux-redesign.md §2.2 item 1)", () => {
  it("defaults channel to msedge, headless to true, and the navigation hosts to the documented lists", () => {
    const config = GlobalConfigSchema.parse({ version: 1, browser: { profilePath: "C:\\profile" } });
    expect(config.browser.channel).toBe("msedge");
    expect(config.browser.headless).toBe(true);
    expect(config.browser.acceptDownloads).toBe(true);
    expect(config.downloadDefaultsVersion).toBe(1);
    expect(config.navigation.appHosts).toEqual([...DEFAULT_APP_HOSTS]);
    expect(config.navigation.authHosts).toEqual([...DEFAULT_AUTH_HOSTS]);
    expect(config.navigation.downloadHosts).toEqual([...DEFAULT_DOWNLOAD_HOSTS]);
    // The documented out-of-the-box list (README "File-producing agents"): every tenant's SharePoint
    // Online / OneDrive for Business host, plus consumer OneDrive.
    expect(DEFAULT_DOWNLOAD_HOSTS).toEqual(["*.sharepoint.com", "onedrive.live.com"]);
  });
  it("accepts every browser.channel value, and rejects a channel outside the enum", () => {
    for (const channel of ["msedge", "chrome", "chromium"] as const)
      expect(
        GlobalConfigSchema.safeParse({ version: 1, browser: { channel, profilePath: "C:\\profile" } }).success
      ).toBe(true);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { channel: "firefox", profilePath: "C:\\profile" }
      }).success
    ).toBe(false);
  });
  it("defaults the response, acknowledgement, typing and attachment timings", () => {
    const config = GlobalConfigSchema.parse({ version: 1, browser: { profilePath: "C:\\profile" } });
    // Real Microsoft 365 agents routinely stream for minutes; two minutes was too short.
    expect(config.browser.responseTimeoutMs).toBe(300000);
    expect(config.browser.ackTimeoutMs).toBe(30000);
    expect(config.browser.responseStartTimeoutMs).toBe(90000);
    expect(config.browser.typingDelayMs).toBe(20);
    expect(config.browser.attachmentSettleMs).toBe(2000);
  });

  it("defaults the attachment retention and quota, and rejects unusable limits", () => {
    const config = GlobalConfigSchema.parse({ version: 1, browser: { profilePath: "C:\\profile" } });
    expect(config.security.attachmentRetentionHours).toBe(168);
    expect(config.security.attachmentQuotaBytes).toBe(1024 * 1024 * 1024);
    const rejected = [
      { attachmentRetentionHours: 0 },
      { attachmentRetentionHours: 1.5 },
      // A quota below one mebibyte would delete a single saved response immediately.
      { attachmentQuotaBytes: 1024 },
      { attachmentQuotaBytes: -1 }
    ];
    for (const security of rejected)
      expect(
        GlobalConfigSchema.safeParse({ version: 1, browser: { profilePath: "C:\\profile" }, security })
          .success
      ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        browser: { profilePath: "C:\\profile" },
        security: { attachmentRetentionHours: 1, attachmentQuotaBytes: 1024 * 1024 }
      }).success
    ).toBe(true);
  });

  it("defaults the browser knobs to an empty switch list and a fixed viewport", () => {
    const config = GlobalConfigSchema.parse({ version: 1, browser: { profilePath: "C:\\profile" } });
    // Nothing automation-related is enabled implicitly: an operator must ask for each switch.
    expect(config.browser.args).toEqual([]);
    expect(config.browser.viewport).toEqual({ width: 1440, height: 900 });
    expect(config.browser.userAgent).toBeUndefined();
    expect(config.browser.locale).toBeUndefined();
    expect(config.browser.timezoneId).toBeUndefined();
  });

  it("accepts the documented browser knobs and rejects malformed ones", () => {
    const accepted = GlobalConfigSchema.safeParse({
      version: 1,
      browser: {
        profilePath: "C:\\profile",
        typingDelayMs: 0,
        args: ["--disable-blink-features=AutomationControlled"],
        viewport: { width: 1280, height: 1024 },
        userAgent: "Mozilla/5.0 (test)",
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo"
      }
    });
    expect(accepted.success).toBe(true);

    const rejected = [
      { typingDelayMs: 201 },
      { typingDelayMs: -1 },
      // A switch that is not a long-form flag could be read as a positional argument (a URL).
      { args: ["--ok", "https://evil.example"] },
      { args: ["-single-dash"] },
      { args: Array.from({ length: 21 }, (_, index) => `--switch-${index}`) },
      { viewport: { width: 100, height: 900 } },
      { viewport: { width: 1440, height: 99999 } },
      { locale: "not a locale" }
    ];
    for (const browser of rejected)
      expect(
        GlobalConfigSchema.safeParse({ version: 1, browser: { profilePath: "C:\\profile", ...browser } })
          .success
      ).toBe(false);
  });

  it("still accepts an older config file that explicitly sets headless:false and its own explicit host lists", () => {
    const config = GlobalConfigSchema.parse({
      version: 1,
      browser: { channel: "msedge", headless: false, profilePath: "C:\\profile" },
      navigation: { appHosts: ["contoso.example"], authHosts: ["login.contoso.example"], downloadHosts: [] }
    });
    expect(config.browser.headless).toBe(false);
    expect(config.navigation.appHosts).toEqual(["contoso.example"]);
    expect(config.navigation.authHosts).toEqual(["login.contoso.example"]);
  });
});

describe("config migration seam (§41.1)", () => {
  const kinds: StoreKind[] = ["global-config", "registry", "approvals", "workspace-config"];
  for (const kind of kinds) {
    it(`${kind}: passes version 1 through unchanged`, () => {
      const raw = { version: 1, marker: kind };
      expect(migrateStore(kind, raw)).toBe(raw);
    });
    it(`${kind}: fails closed on a newer version, with a remediation naming the file`, () => {
      let caught: unknown;
      try {
        migrateStore(kind, { version: 2 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      const domain = caught as DomainError;
      expect(domain.message).toMatch(/version 2/);
      const result = domain.toResult("req").error;
      expect(result.remediation).toBeTruthy();
    });
    it(`${kind}: fails closed when the version field is missing`, () => {
      let caught: unknown;
      try {
        migrateStore(kind, { notVersion: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).message).toMatch(/no version field/);
    });
  }
  it("uses WORKSPACE_CONFIG_INVALID for the repository-authored workspace config, and an existing local-state code for the user-owned stores", () => {
    const codeFor = (kind: StoreKind): string => {
      try {
        migrateStore(kind, { version: 2 });
        return "";
      } catch (error) {
        return (error as DomainError).code;
      }
    };
    expect(codeFor("workspace-config")).toBe("WORKSPACE_CONFIG_INVALID");
    expect(codeFor("global-config")).not.toBe("WORKSPACE_CONFIG_INVALID");
    expect(codeFor("registry")).not.toBe("WORKSPACE_CONFIG_INVALID");
    expect(codeFor("approvals")).not.toBe("WORKSPACE_CONFIG_INVALID");
  });
});

describe("schemas/*.json are generated from the zod schemas (drift guard)", () => {
  const generatedTargets: Array<{
    file: string;
    id: string;
    title: string;
    schema: Parameters<typeof toDocumentedJsonSchema>[2];
  }> = [
    {
      file: "agent-registry.schema.json",
      id: "agent-registry.schema.json",
      title: "AgentPickLink local registry",
      schema: RegistrySchema
    },
    {
      file: "approvals.schema.json",
      id: "approvals.schema.json",
      title: "AgentPickLink local approvals",
      schema: ApprovalStoreSchema
    },
    {
      file: "workspace-config.schema.json",
      id: "workspace-config.schema.json",
      title: "AgentPickLink workspace request",
      schema: WorkspaceConfigSchema
    }
  ];
  for (const target of generatedTargets) {
    it(`schemas/${target.file} matches z.toJSONSchema(${target.id.split(".")[0]}) plus its documentation metadata`, async () => {
      const checkedIn = await readFile(path.join(repoRoot, "schemas", target.file), "utf8");
      const regenerated = `${JSON.stringify(toDocumentedJsonSchema(target.id, target.title, target.schema), null, 2)}\n`;
      expect(checkedIn).toBe(regenerated);
    });
  }
});
