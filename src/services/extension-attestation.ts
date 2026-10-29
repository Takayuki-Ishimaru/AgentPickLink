import type { ExtensionRelease } from "./extension-update.js";
import { createHash } from "node:crypto";
import { get } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TrustMaterial, VerificationPolicy } from "@sigstore/verify";

export const ATTESTATION_REPOSITORY = "Takayuki-Ishimaru/AgentPickLink";
export const ATTESTATION_WORKFLOW = ".github/workflows/release-build.yml";
export const ATTESTATION_REPOSITORY_ID = "1361038486";
export const ATTESTATION_OWNER_ID = "313892414";
export const ATTESTATION_TIMEOUT_MS = 45_000;
const REPOSITORY_URL = `https://github.com/${ATTESTATION_REPOSITORY}`;
const API = `https://api.github.com/repos/${ATTESTATION_REPOSITORY}`;
const ISSUER = "https://token.actions.githubusercontent.com";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export type VerifiedExtensionAttestation = {
  version: 1;
  sha256: string;
  tag: string;
  sourceCommit: string;
  workflow: typeof ATTESTATION_WORKFLOW;
  verifiedAt: string;
};

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("update-attestation-format");
  return value as JsonRecord;
}
function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error("update-attestation-policy");
}

/** Dependencies separate transport/trust-root acquisition from verification. Neither the signature
 * verifier nor the release identity policy is replaceable. Production always uses the public TUF root. */
export type AttestationDependencies = {
  fetchJSON(url: string, signal: AbortSignal): Promise<unknown>;
  trustMaterial(): Promise<TrustMaterial>;
};

async function trustedMaterial(): Promise<TrustMaterial> {
  // Lazy loading keeps older extension hosts operational; only automatic update verification
  // requires the security SDK's supported runtime. No user-supplied mirror, root, or keys.
  const [tuf, verification] = await Promise.all([import("@sigstore/tuf"), import("@sigstore/verify")]);
  const root = await tuf.getTrustedRoot({
    mirrorURL: "https://tuf-repo-cdn.sigstore.dev",
    timeout: 5_000,
    retry: 0,
    forceCache: false
  });
  return verification.toTrustMaterial(root);
}

/** Public API. No proof, no network, an unsupported host, or any verification failure rejects. */
export const verifyExtensionAttestation = createExtensionAttestationVerifier({
  fetchJSON: fetchAttestationJSON,
  trustMaterial: trustedMaterial
});

export function createExtensionAttestationVerifier(deps: AttestationDependencies) {
  return async (
    release: ExtensionRelease,
    bytes: Buffer,
    signal: AbortSignal
  ): Promise<VerifiedExtensionAttestation> => {
    if (signal.aborted) throw new Error("update-attestation-aborted");
    assertSupportedRuntime();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline: (() => void) | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = () =>
        reject(new Error(timedOut ? "update-attestation-timeout" : "update-attestation-aborted"));
      controller.signal.addEventListener("abort", rejectDeadline, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ATTESTATION_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([verify(release, bytes, controller.signal, deps), deadline]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (rejectDeadline) controller.signal.removeEventListener("abort", rejectDeadline);
      // Stop sibling API requests as soon as any branch rejects; no late network result can
      // outlive this verification and accidentally become a later install authorization.
      controller.abort();
    }
  };
}

/** Also used before downloading a VSIX on older VS Code extension hosts. */
export function supportsExtensionAttestation(nodeVersion = process.versions.node): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) return false;
  const [major, minor, patch] = nodeVersion.split(".").map(Number);
  return (
    major >= 26 ||
    (major === 24 && minor >= 15) ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
  );
}

function assertSupportedRuntime(): void {
  if (!supportsExtensionAttestation()) throw new Error("update-attestation-node-version");
}

async function verify(
  release: ExtensionRelease,
  bytes: Buffer,
  signal: AbortSignal,
  deps: AttestationDependencies
): Promise<VerifiedExtensionAttestation> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(release.tag) ||
    release.name !== `agent-pick-link-${release.tag.slice(1)}.vsix` ||
    sha256 !== release.sha256 ||
    bytes.length !== release.size
  )
    throw new Error("update-attestation-artifact");
  const [sourceCommit, response, trust] = await Promise.all([
    resolveTag(release.tag, signal, deps.fetchJSON),
    deps.fetchJSON(`${API}/attestations/sha256:${sha256}?per_page=20`, signal),
    deps.trustMaterial()
  ]);
  if (signal.aborted) throw new Error("update-attestation-aborted");
  const attestations = object(response).attestations;
  if (!Array.isArray(attestations) || !attestations.length || attestations.length > 20)
    throw new Error("update-attestation-missing");
  const [{ bundleFromJSON, isBundleWithDsseEnvelope }, { Verifier, toSignedEntity }] = await Promise.all([
    import("@sigstore/bundle"),
    import("@sigstore/verify")
  ]);
  const verifier = new Verifier(trust, { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 });
  for (const attestation of attestations) {
    if (signal.aborted) throw new Error("update-attestation-aborted");
    try {
      const bundle = bundleFromJSON(object(object(attestation).bundle));
      if (!isBundleWithDsseEnvelope(bundle)) continue;
      equal(bundle.content.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
      // Verification includes Fulcio chain + SCT, authenticated signing time, Rekor inclusion,
      // DSSE signature, and the exact authenticated certificate identity/claims below.
      const entity = toSignedEntity(bundle);
      if (entity.key.$case !== "certificate") continue;
      verifier.verify(entity, certificatePolicy(release.tag, sourceCommit));
      const statement = JSON.parse(bundle.content.dsseEnvelope.payload.toString("utf8"));
      verifyStatement(statement, release, sourceCommit);
      if (signal.aborted) throw new Error("update-attestation-aborted");
      return {
        version: 1,
        sha256,
        tag: release.tag,
        sourceCommit,
        workflow: ATTESTATION_WORKFLOW,
        verifiedAt: new Date().toISOString()
      };
    } catch {
      // An unrelated or invalid attestation never authorizes installation. A distinct, valid
      // attestation for this exact artifact may still follow in the bounded response.
    }
  }
  throw new Error("update-attestation-verification-failed");
}

async function resolveTag(
  tag: string,
  signal: AbortSignal,
  fetchJSON: AttestationDependencies["fetchJSON"]
): Promise<string> {
  const ref = object(await fetchJSON(`${API}/git/ref/tags/${encodeURIComponent(tag)}`, signal));
  equal(ref.ref, `refs/tags/${tag}`);
  let target = object(ref.object);
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof target.sha !== "string" || !/^[a-f0-9]{40}$/.test(target.sha) || seen.has(target.sha)) break;
    seen.add(target.sha);
    if (target.type === "commit") return target.sha;
    if (target.type !== "tag") break;
    const annotated = object(await fetchJSON(`${API}/git/tags/${target.sha}`, signal));
    equal(annotated.sha, target.sha);
    target = object(annotated.object);
  }
  throw new Error("update-attestation-tag");
}

/** Fulcio v2 claim values are DER UTF8Strings, not bare strings. */
function utf8DER(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = bytes.length;
  if (length > 65535) throw new Error("update-attestation-policy");
  return Buffer.concat([
    Buffer.from(
      length < 128
        ? [0x0c, length]
        : length < 256
          ? [0x0c, 0x81, length]
          : [0x0c, 0x82, length >> 8, length & 255]
    ),
    bytes
  ]);
}

function certificatePolicy(tag: string, commit: string): VerificationPolicy {
  const ref = `refs/tags/${tag}`;
  const identity = `${REPOSITORY_URL}/${ATTESTATION_WORKFLOW}@${ref}`;
  const claims: Array<[number, string]> = [
    [9, identity],
    [10, commit],
    [11, "github-hosted"],
    [12, REPOSITORY_URL],
    [13, commit],
    [14, ref],
    [15, ATTESTATION_REPOSITORY_ID],
    [17, ATTESTATION_OWNER_ID],
    [18, identity],
    [19, commit]
  ];
  return {
    // The SDK treats strings as regular expressions too: anchor and escape every character.
    subjectAlternativeName: new RegExp(`^${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    extensions: { issuer: ISSUER },
    oids: claims.map(([suffix, value]) => ({
      oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, suffix] },
      value: utf8DER(value)
    }))
  };
}

function verifyStatement(value: unknown, release: ExtensionRelease, commit: string): void {
  const statement = object(value);
  equal(statement._type, "https://in-toto.io/Statement/v1");
  equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  if (!Array.isArray(statement.subject)) throw new Error("update-attestation-subject");
  const subjects = statement.subject.map(object).filter((subject) => subject.name === release.name);
  equal(subjects.length, 1);
  equal(object(subjects[0].digest).sha256, release.sha256);
  const predicate = object(statement.predicate);
  const build = object(predicate.buildDefinition);
  equal(build.buildType, "https://actions.github.io/buildtypes/workflow/v1");
  const workflow = object(object(build.externalParameters).workflow);
  equal(workflow.repository, REPOSITORY_URL);
  equal(workflow.path, ATTESTATION_WORKFLOW);
  equal(workflow.ref, `refs/tags/${release.tag}`);
  const github = object(object(build.internalParameters).github);
  equal(github.repository_id, ATTESTATION_REPOSITORY_ID);
  equal(github.repository_owner_id, ATTESTATION_OWNER_ID);
  equal(github.runner_environment, "github-hosted");
  if (!Array.isArray(build.resolvedDependencies)) throw new Error("update-attestation-source");
  const sources = build.resolvedDependencies
    .map(object)
    .filter((dep) => dep.uri === `git+${REPOSITORY_URL}@refs/tags/${release.tag}`);
  equal(sources.length, 1);
  equal(object(sources[0].digest).gitCommit, commit);
  equal(
    object(object(predicate.runDetails).builder).id,
    `${REPOSITORY_URL}/${ATTESTATION_WORKFLOW}@refs/tags/${release.tag}`
  );
}

/** API responses are bounded, authenticated by TLS, and never redirect to another host. They
 * locate evidence; only the separately authenticated Sigstore trust root can authenticate it. */
export async function fetchAttestationJSON(input: string, signal: AbortSignal): Promise<unknown> {
  const url = new URL(input);
  if (
    url.origin !== "https://api.github.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(`/repos/${ATTESTATION_REPOSITORY}/`)
  )
    return Promise.reject(new Error("update-attestation-url"));
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new Error("update-attestation-aborted"));
    const timer = setTimeout(() => finish(new Error("update-attestation-http-timeout")), 10_000);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      request = get(
        url,
        {
          signal,
          headers: {
            "User-Agent": "AgentPickLink",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
          }
        },
        (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          response = res;
          res.on("error", (error) => finish(error));
          res.on("aborted", () => finish(new Error("update-attestation-truncated")));
          let ended = false;
          res.on("close", () => {
            if (!ended) finish(new Error("update-attestation-truncated"));
          });
          if (res.statusCode !== 200) {
            finish(new Error("update-attestation-http"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_JSON_BYTES) finish(new Error("update-attestation-size"));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            ended = true;
            if (settled) return;
            try {
              finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              finish(new Error("update-attestation-json"));
            }
          });
        }
      );
      request.on("error", (error) => finish(error));
    } catch {
      finish(new Error("update-attestation-http"));
    }
  });
}
