import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import {
  createExtensionAttestationVerifier,
  ATTESTATION_TIMEOUT_MS,
  fetchAttestationJSON
} from "../../src/services/extension-attestation.js";
import {
  attestationFixture,
  bytes,
  identity,
  release,
  sourceCommit,
  statement
} from "../helpers/attestation-fixture.js";
import { Verifier, toSignedEntity } from "@sigstore/verify";
import { bundleFromJSON } from "@sigstore/bundle";

describe("mandatory extension build attestation", () => {
  let fixture: Awaited<ReturnType<typeof attestationFixture>>;
  beforeAll(async () => {
    fixture = await attestationFixture();
  });
  afterEach(() => vi.useRealTimers());
  function verifier(
    bundle: unknown,
    options: { annotated?: boolean; commit?: string; noTrust?: boolean } = {}
  ) {
    const fetchJSON = vi.fn(async (url: string) => {
      if (url.includes("/attestations/")) return { attestations: bundle === undefined ? [] : [{ bundle }] };
      if (url.includes("/git/tags/"))
        return { sha: "b".repeat(40), object: { type: "commit", sha: options.commit ?? sourceCommit } };
      return {
        ref: `refs/tags/${release.tag}`,
        object: {
          type: options.annotated ? "tag" : "commit",
          sha: options.annotated ? "b".repeat(40) : (options.commit ?? sourceCommit)
        }
      };
    });
    const verify = createExtensionAttestationVerifier({
      fetchJSON,
      trustMaterial: async () =>
        options.noTrust ? { ...fixture.trust, certificateAuthorities: [] } : fixture.trust
    });
    return { verify, fetchJSON };
  }
  const signal = () => new AbortController().signal;
  it("validates the fixture's real signature, CA, SCT and transparency log", async () => {
    const bundle = bundleFromJSON(await fixture.bundle());
    expect(new Verifier(fixture.trust).verify(toSignedEntity(bundle)).identity?.subjectAlternativeName).toBe(
      identity
    );
  });

  it.each([false, true])(
    "accepts a cryptographically valid hosted build for the exact artifact and tag (annotated=%s)",
    async (annotated) => {
      const { verify, fetchJSON } = verifier(await fixture.bundle(), { annotated });
      await expect(verify(release, bytes, signal())).resolves.toMatchObject({
        version: 1,
        sha256: release.sha256,
        tag: release.tag,
        sourceCommit,
        workflow: ".github/workflows/release-build.yml"
      });
      expect(fetchJSON.mock.calls.some(([url]) => url.includes("/git/tags/"))).toBe(annotated);
    }
  );
  it("refuses an absent proof even when the GitHub asset digest matches", async () => {
    await expect(verifier(undefined).verify(release, bytes, signal())).rejects.toThrow("attestation-missing");
  });
  it("refuses an untrusted certificate authority", async () => {
    await expect(
      verifier(await fixture.bundle(), { noTrust: true }).verify(release, bytes, signal())
    ).rejects.toThrow("verification-failed");
  });
  it("refuses a moved tag whose resolved commit differs from the signed build", async () => {
    await expect(
      verifier(await fixture.bundle(), { commit: "c".repeat(40) }).verify(release, bytes, signal())
    ).rejects.toThrow("verification-failed");
  });
  it.each([
    ["issuer", 8, "https://attacker.invalid"],
    ["runner", 11, "self-hosted"],
    ["repository", 12, "https://github.com/attacker/AgentPickLink"],
    ["source commit", 13, "c".repeat(40)],
    ["tag", 14, "refs/heads/main"],
    ["repository ID", 15, "1"],
    ["owner ID", 17, "1"],
    ["workflow", 9, identity.replace("release-build.yml", "other.yml")],
    ["build signer commit", 10, "c".repeat(40)],
    ["missing runner claim", 11, undefined]
  ] as const)("refuses a valid signature with the wrong %s claim", async (_name, oid, value) => {
    await expect(
      verifier(await fixture.bundle({ claims: { [oid]: value } })).verify(release, bytes, signal())
    ).rejects.toThrow("verification-failed");
  });
  it.each([
    `${identity}/extra`,
    identity.replace("github.com", "githubXcom"),
    identity.replace("release-build.yml", "other.yml")
  ])("anchors and escapes the certificate SAN: %s", async (san) => {
    await expect(
      verifier(await fixture.bundle({ identity: san })).verify(release, bytes, signal())
    ).rejects.toThrow("verification-failed");
  });
  it.each([
    "digest",
    "name",
    "predicate",
    "workflow",
    "ref",
    "commit",
    "runner",
    "builder",
    "repository ID",
    "owner ID"
  ])("refuses a signed statement with wrong %s", async (field) => {
    const value = statement();
    switch (field) {
      case "digest":
        value.subject[0].digest.sha256 = "0".repeat(64);
        break;
      case "name":
        value.subject[0].name = "another.vsix";
        break;
      case "predicate":
        value.predicateType = "https://example.invalid/predicate";
        break;
      case "workflow":
        value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
        break;
      case "ref":
        value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
        break;
      case "commit":
        value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "c".repeat(40);
        break;
      case "runner":
        value.predicate.buildDefinition.internalParameters.github.runner_environment = "self-hosted";
        break;
      case "builder":
        value.predicate.runDetails.builder.id = identity.replace("release-build.yml", "other.yml");
        break;
      case "repository ID":
        value.predicate.buildDefinition.internalParameters.github.repository_id = "1";
        break;
      case "owner ID":
        value.predicate.buildDefinition.internalParameters.github.repository_owner_id = "1";
        break;
    }
    await expect(
      verifier(await fixture.bundle({ statement: value })).verify(release, bytes, signal())
    ).rejects.toThrow("verification-failed");
  });
  it.each(["signature", "payload", "log signature", "log checkpoint", "missing log"])(
    "refuses forged or missing %s",
    async (field) => {
      const bundle = await fixture.bundle();
      switch (field) {
        case "signature":
          bundle.dsseEnvelope!.signatures[0].sig = Buffer.alloc(72).toString("base64");
          break;
        case "payload":
          bundle.dsseEnvelope!.payload = Buffer.from(JSON.stringify(statement()))
            .subarray(1)
            .toString("base64");
          break;
        case "log signature":
          bundle.verificationMaterial.tlogEntries[0].inclusionPromise!.signedEntryTimestamp =
            Buffer.alloc(72).toString("base64");
          break;
        case "log checkpoint":
          bundle.verificationMaterial.tlogEntries[0].inclusionProof!.checkpoint.envelope =
            bundle.verificationMaterial.tlogEntries[0].inclusionProof!.checkpoint.envelope.replace(
              "test-rekor.invalid",
              "forged.invalid"
            );
          break;
        case "missing log":
          bundle.verificationMaterial.tlogEntries = [];
          break;
      }
      await expect(verifier(bundle).verify(release, bytes, signal())).rejects.toThrow("verification-failed");
    }
  );
  it("rehashes the bytes instead of trusting release metadata", async () => {
    await expect(
      verifier(await fixture.bundle()).verify(release, Buffer.alloc(bytes.length), signal())
    ).rejects.toThrow("artifact");
  });
  it("does not request anything after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { verify, fetchJSON } = verifier(undefined);
    await expect(verify(release, bytes, controller.signal)).rejects.toThrow("aborted");
    expect(fetchJSON).not.toHaveBeenCalled();
  });
  it("fails closed on an older extension host before loading SDK or contacting services", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    const { verify, fetchJSON } = verifier(undefined);
    try {
      Object.defineProperty(process.versions, "node", { ...descriptor, value: "22.21.0" });
      await expect(verify(release, bytes, signal())).rejects.toThrow("attestation-node-version");
      expect(fetchJSON).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.versions, "node", descriptor);
    }
  });
  it("bounds both API and TUF waits and never treats a timeout as success", async () => {
    vi.useFakeTimers();
    const verify = createExtensionAttestationVerifier({
      fetchJSON: () => new Promise(() => {}),
      trustMaterial: () => new Promise(() => {})
    });
    const failure = expect(verify(release, bytes, signal())).rejects.toThrow("attestation-");
    await vi.advanceTimersByTimeAsync(ATTESTATION_TIMEOUT_MS + 1);
    await failure;
  });
  it("propagates an unavailable trust root as a verification failure", async () => {
    const verify = createExtensionAttestationVerifier({
      fetchJSON: async () => ({}),
      trustMaterial: async () => {
        throw new Error("TUF verification rejected");
      }
    });
    await expect(verify(release, bytes, signal())).rejects.toThrow();
  });
  it.each([
    "http://api.github.com/repos/Takayuki-Ishimaru/AgentPickLink/a",
    "https://evil.invalid/a",
    "https://api.github.com/repos/other/repository/a"
  ])("rejects untrusted API destinations: %s", async (url) => {
    await expect(fetchAttestationJSON(url, signal())).rejects.toThrow("attestation-url");
  });
});
