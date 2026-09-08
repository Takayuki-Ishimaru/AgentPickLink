import { z } from "zod";
import { AliasSchema, BindingFingerprintSchema, CapabilityClassSchema } from "../domain/agent.js";
import { DEFAULT_APP_HOSTS, DEFAULT_AUTH_HOSTS, DEFAULT_DOWNLOAD_HOSTS } from "./defaults.js";
import { isExactHostname, isHostPattern } from "../domain/host-pattern.js";
/** A single Chromium command-line switch. Only long-form switches are accepted so a value can
 * never be mistaken for a positional argument (an URL, a profile path) by the browser. */
const BrowserArgSchema = z
  .string()
  .min(3)
  .max(200)
  .refine((value) => value.startsWith("--") && !/\s/.test(value.slice(0, 2)), {
    message: "Browser arguments must be long-form Chromium switches starting with --"
  });
/** RFC 5646 shape only (language[-script][-region][-variant]); the browser validates the rest. */
const BcpTagSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, "locale must be a BCP-47 language tag");
const ExactHostSchema = z
  .string()
  .min(1)
  .refine(
    isExactHostname,
    "Navigation hosts must be exact hostnames without wildcards, schemes, paths, or ports"
  );
/** `navigation.downloadHosts` entries: an exact hostname or a `*.` wildcard suffix such as
 * `*.sharepoint.com` (semantics in src/domain/host-pattern.ts). The application and authentication
 * host lists stay exact: a wildcard there would widen where the automation may *navigate*, not
 * merely which hosts a response file may be fetched from. */
const DownloadHostSchema = z
  .string()
  .min(1)
  .refine(
    isHostPattern,
    "Download hosts must be exact hostnames or `*.` wildcards on a domain of at least two labels (for example `*.sharepoint.com`), without schemes, paths, or ports"
  );
export const GlobalConfigSchema = z
  .object({
    version: z.literal(1),
    /** One-time migration marker for the default SharePoint/OneDrive download policy. */
    downloadDefaultsVersion: z.literal(1).default(1),
    /** One-time migration marker for the hidden automation-browser default. */
    headlessDefaultsVersion: z.literal(1).default(1),
    runtime: z
      .object({ brokerProtocolMajor: z.literal(1) })
      .strict()
      .default({ brokerProtocolMajor: 1 }),
    browser: z
      .object({
        channel: z.enum(["msedge", "chrome", "chromium"]).default("msedge"),
        headless: z.boolean().default(true),
        profilePath: z.string().min(1),
        startupTimeoutMs: z.number().int().positive().default(45000),
        navigationTimeoutMs: z.number().int().positive().default(45000),
        /** Whole-response budget, measured from the moment the prompt was submitted. Real
         * Microsoft 365 agents routinely stream for minutes before they finish. */
        responseTimeoutMs: z.number().int().positive().default(300000),
        /** How long to wait for the submitted prompt to appear as a user message. */
        ackTimeoutMs: z.number().int().positive().default(30000),
        /** How long to wait for the agent's first response node after acknowledgement. */
        responseStartTimeoutMs: z.number().int().positive().default(90000),
        /** Per-character delay used when typing into a rich-text composer. */
        typingDelayMs: z.number().int().min(0).max(200).default(20),
        /** Grace period after completion before a second, cheap attachment re-scan. */
        attachmentSettleMs: z.number().int().min(0).max(60000).default(2000),
        stabilityWindowMs: z.number().int().positive().default(1800),
        pollIntervalMs: z.number().int().positive().default(250),
        idleShutdownMinutes: z.number().int().positive().default(30),
        acceptDownloads: z.boolean().default(true),
        /** Optional browser knobs handed straight to the persistent context. */
        userAgent: z.string().min(1).max(512).optional(),
        args: z.array(BrowserArgSchema).max(20).default([]),
        viewport: z
          .object({
            width: z.number().int().min(800).max(4096).default(1440),
            height: z.number().int().min(600).max(4096).default(900)
          })
          .strict()
          .default({ width: 1440, height: 900 }),
        locale: BcpTagSchema.optional(),
        timezoneId: z.string().min(1).max(64).optional(),
        maxAttachments: z.number().int().min(1).max(20).default(10),
        maxAttachmentBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(25 * 1024 * 1024),
        maxTotalAttachmentBytes: z
          .number()
          .int()
          .min(1)
          .max(500 * 1024 * 1024)
          .default(100 * 1024 * 1024)
      })
      .strict(),
    conversations: z
      .object({
        maxPerWorkspace: z.number().int().positive().default(6),
        maxTotal: z.number().int().positive().default(10),
        idleExpirationMinutes: z.number().int().positive().default(30),
        perConversationQueueLimit: z.number().int().positive().default(3)
      })
      .strict()
      .default({ maxPerWorkspace: 6, maxTotal: 10, idleExpirationMinutes: 30, perConversationQueueLimit: 3 }),
    invocation: z
      .object({
        maxConcurrentTotal: z.number().int().positive().default(4),
        maxPerMinutePerWorkspace: z.number().int().positive().default(30)
      })
      .strict()
      .default({ maxConcurrentTotal: 4, maxPerMinutePerWorkspace: 30 }),
    security: z
      .object({
        allowArbitraryUrls: z.literal(false).default(false),
        allowedCapabilityClasses: z
          .array(z.enum(["knowledge-only", "actions-possible"]))
          .min(1)
          .max(2)
          .refine((items) => new Set(items).size === items.length, "Capability classes must be unique")
          .default(["knowledge-only"]),
        uiActionPolicy: z.literal("never-click").default("never-click"),
        storePromptBodies: z.literal(false).default(false),
        storeResponseBodies: z.literal(false).default(false),
        saveFailureHtml: z.literal(false).default(false),
        saveFailureScreenshot: z.literal(false).default(false),
        diagnosticRetentionHours: z.number().int().positive().default(24),
        /** How long a saved response attachment is kept before the broker deletes it (per request
         * directory, by directory mtime). Default one week. */
        attachmentRetentionHours: z.number().int().min(1).default(168),
        /** Upper bound on everything under the attachments directory. Once the retention pass is
         * done, the oldest request directories are deleted until the tree fits. Default 1 GiB. */
        attachmentQuotaBytes: z
          .number()
          .int()
          .min(1024 * 1024)
          .default(1024 * 1024 * 1024)
      })
      .strict()
      .default({
        allowArbitraryUrls: false,
        allowedCapabilityClasses: ["knowledge-only"],
        uiActionPolicy: "never-click",
        storePromptBodies: false,
        storeResponseBodies: false,
        saveFailureHtml: false,
        saveFailureScreenshot: false,
        diagnosticRetentionHours: 24,
        attachmentRetentionHours: 168,
        attachmentQuotaBytes: 1024 * 1024 * 1024
      }),
    navigation: z
      .object({
        appHosts: z
          .array(ExactHostSchema)
          .max(20)
          .default([...DEFAULT_APP_HOSTS]),
        authHosts: z
          .array(ExactHostSchema)
          .max(40)
          .default([...DEFAULT_AUTH_HOSTS]),
        downloadHosts: z
          .array(DownloadHostSchema)
          .max(20)
          .default([...DEFAULT_DOWNLOAD_HOSTS])
      })
      .strict()
      .default({
        appHosts: [...DEFAULT_APP_HOSTS],
        authHosts: [...DEFAULT_AUTH_HOSTS],
        downloadHosts: [...DEFAULT_DOWNLOAD_HOSTS]
      }),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        audit: z.boolean().default(true)
      })
      .strict()
      .default({ level: "info", audit: true })
  })
  .strict();
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
/** Development only: the same switch NavigationPolicy honours (`allowInsecureLoopback`) lets the
 * registry hold an `http://127.0.0.1`/`localhost` entry point so the mock chat app can be driven
 * end to end. It is read once at load time and never relaxes anything for a non-loopback host. */
const DEV_INSECURE_LOOPBACK = process.env.M365_AGENT_DEV_INSECURE_LOOPBACK === "1";
const HttpsUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return !url.port || url.port === "443";
    return (
      DEV_INSECURE_LOOPBACK &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}, "A direct chat entry point must use credential-free HTTPS on the default port");
const BrowserAgentSchema = z
  .object({
    alias: AliasSchema,
    displayName: z.string().min(1),
    kind: z.enum(["m365-agent-builder", "sharepoint-agent", "copilot-studio"]),
    transport: z.literal("browser"),
    entryPoint: z
      .object({
        mode: z.literal("direct-chat"),
        url: HttpsUrlSchema,
        surface: z.enum(["m365-copilot", "teams-web"])
      })
      .strict(),
    description: z.string().optional(),
    usageHint: z.string().optional(),
    enabled: z.boolean(),
    capabilityClass: CapabilityClassSchema,
    uiActionPolicy: z.literal("never-click"),
    verification: z
      .object({
        status: z.enum(["verified", "unverified"]),
        adapterId: z.string().min(1),
        expectedDisplayName: z.string().min(1),
        expectedStableAgentId: z.string().optional(),
        expectedSurface: z.enum(["m365-copilot", "teams-web"]),
        validatedUrlPattern: z
          .string()
          .min(1)
          .refine((value) => {
            try {
              void new RegExp(value);
              return true;
            } catch {
              return false;
            }
          }, "validatedUrlPattern must be a valid regular expression"),
        bindingFingerprint: BindingFingerprintSchema,
        validatedAt: z.string().datetime()
      })
      .strict()
  })
  .strict();
export const RegistrySchema = z
  .object({
    version: z.literal(1),
    agents: z
      .array(BrowserAgentSchema)
      .max(100)
      .superRefine((agents, ctx) => {
        const aliases = new Set<string>();
        agents.forEach((agent, i) => {
          if (aliases.has(agent.alias))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, "alias"],
              message: "Agent aliases must be unique"
            });
          aliases.add(agent.alias);
        });
      })
  })
  .strict();
export const ApprovalStoreSchema = z
  .object({
    version: z.literal(1),
    approvals: z.array(
      z
        .object({
          workspaceKey: z.string().regex(/^[a-f0-9]{24}$/),
          approvedBindings: z
            .array(
              z
                .object({
                  alias: AliasSchema,
                  bindingFingerprint: BindingFingerprintSchema,
                  capabilityClass: z.enum(["knowledge-only", "actions-possible"])
                })
                .strict()
            )
            .max(20),
          approvedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
          approvedAt: z.string().datetime(),
          approvalVersion: z.literal(1)
        })
        .strict()
    )
  })
  .strict();

/**
 * Renders a zod schema through `z.toJSONSchema` and adds the same top-level `$schema`/`$id`/
 * `title` envelope the checked-in schemas/*.json files have always carried by hand (those
 * fields are documentation metadata zod has no opinion on -- it only knows the shape). Shared
 * by scripts/generate-schemas.mjs (compiled, via dist) and its drift-guard test (source, via
 * vitest's on-the-fly TS transform) so both run the exact same rendering logic.
 */
export function toDocumentedJsonSchema(
  id: string,
  title: string,
  schema: Parameters<typeof z.toJSONSchema>[0]
): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    $schema: $schema ?? "https://json-schema.org/draft/2020-12/schema",
    $id: `https://example.invalid/agent-pick-link/${id}`,
    title,
    ...generated
  };
}
