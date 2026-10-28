import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { bundleToJSON, toDSSEBundle } from "@sigstore/bundle";
import { dsse, X509Certificate } from "@sigstore/core";
import { initializeCA, initializeCTLog, initializeTLog } from "@sigstore/mock";
import type { TrustMaterial } from "@sigstore/verify";
import type { ExtensionRelease } from "../../src/services/extension-update.js";
import {
  ATTESTATION_REPOSITORY,
  ATTESTATION_REPOSITORY_ID,
  ATTESTATION_OWNER_ID,
  ATTESTATION_WORKFLOW
} from "../../src/services/extension-attestation.js";

export const sourceCommit = "a".repeat(40);
export const bytes = Buffer.from("a synthetic VSIX artifact; never a published release");
export const release: ExtensionRelease = {
  tag: "v0.2.99",
  name: "agent-pick-link-0.2.99.vsix",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: `https://github.com/${ATTESTATION_REPOSITORY}/releases/download/v0.2.99/agent-pick-link-0.2.99.vsix`
};
const repository = `https://github.com/${ATTESTATION_REPOSITORY}`;
export const identity = `${repository}/${ATTESTATION_WORKFLOW}@refs/tags/${release.tag}`;

export function statement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: release.name, digest: { sha256: release.sha256 } }],
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: { repository, path: ATTESTATION_WORKFLOW, ref: `refs/tags/${release.tag}` }
        },
        internalParameters: {
          github: {
            event_name: "push",
            repository_id: ATTESTATION_REPOSITORY_ID,
            repository_owner_id: ATTESTATION_OWNER_ID,
            runner_environment: "github-hosted"
          }
        },
        resolvedDependencies: [
          { uri: `git+${repository}@refs/tags/${release.tag}`, digest: { gitCommit: sourceCommit } }
        ]
      },
      runDetails: { builder: { id: identity } }
    }
  };
}

/** Ephemeral, test-only roots. The production verifier never accepts these roots from its callers.
 * Official Sigstore fixtures generate real CA certificates, SCTs, DSSE signatures and Rekor proofs. */
export async function attestationFixture() {
  const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ctKey = key();
  const logKey = key();
  // The fixture CA is generated now; Rekor's whole-second signing time must fall after the
  // newly-created root's notBefore as well as the leaf's notBefore.
  const clock = new Date(Date.now() + 5000);
  const ctlog = await initializeCTLog(ctKey, clock);
  const ca = await initializeCA(
    generateKeyPairSync("ec", { namedCurve: "secp384r1" }),
    ctlog,
    new Date(clock.getTime() - 1000)
  );
  const tlog = await initializeTLog("https://test-rekor.invalid", logKey, clock);
  const validFor = { start: new Date(0), end: new Date("2100-01-01") };
  const trust: TrustMaterial = {
    certificateAuthorities: [
      { certChain: [X509Certificate.parse(Buffer.from(ca.rootCertificate.buffer))], validFor }
    ],
    timestampAuthorities: [],
    tlogs: [
      {
        logID: createHash("sha256").update(tlog.publicKey).digest(),
        baseURL: "https://test-rekor.invalid",
        publicKey: logKey.publicKey,
        validFor
      }
    ],
    ctlogs: [
      {
        logID: Buffer.from(ctlog.logID.buffer),
        baseURL: "https://test-ct.invalid",
        publicKey: ctKey.publicKey,
        validFor
      }
    ],
    publicKey: () => {
      throw new Error("key-only signatures are never accepted");
    }
  };
  async function bundle(
    options: {
      statement?: unknown;
      identity?: string;
      claims?: Record<number, string | undefined>;
      signer?: ReturnType<typeof key>;
    } = {}
  ) {
    const signer = options.signer ?? key();
    const claims: Record<number, string | undefined> = {
      8: "https://token.actions.githubusercontent.com",
      9: identity,
      10: sourceCommit,
      11: "github-hosted",
      12: repository,
      13: sourceCommit,
      14: `refs/tags/${release.tag}`,
      15: ATTESTATION_REPOSITORY_ID,
      17: ATTESTATION_OWNER_ID,
      18: identity,
      19: sourceCommit,
      ...options.claims
    };
    const certificate = Buffer.from(
      (
        await ca.issueCertificate({
          publicKey: signer.publicKey.export({ format: "der", type: "spki" }),
          subjectAltName: options.identity ?? identity,
          extensions: Object.entries(claims)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([suffix, value]) => ({ oid: `1.3.6.1.4.1.57264.1.${suffix}`, value }))
        })
      ).buffer
    );
    const payload = Buffer.from(JSON.stringify(options.statement ?? statement()));
    const payloadType = "application/vnd.in-toto+json";
    const signature = sign("sha256", dsse.preAuthEncoding(payloadType, payload), signer.privateKey);
    const result = toDSSEBundle({ artifact: payload, artifactType: payloadType, signature, certificate });
    const logged = Object.values(
      await tlog.log({
        kind: "dsse",
        apiVersion: "0.0.1",
        spec: {
          payloadHash: { algorithm: "sha256", value: createHash("sha256").update(payload).digest("hex") },
          signatures: [{ signature: signature.toString("base64"), verifier: certificate.toString("base64") }]
        }
      })
    )[0];
    const proof = logged.verification!.inclusionProof!;
    result.verificationMaterial.tlogEntries = [
      {
        logId: { keyId: Buffer.from(logged.logID, "hex") },
        logIndex: String(logged.logIndex),
        integratedTime: String(logged.integratedTime),
        kindVersion: { kind: "dsse", version: "0.0.1" },
        canonicalizedBody: Buffer.from(logged.body as string, "base64"),
        inclusionPromise: {
          signedEntryTimestamp: Buffer.from(logged.verification!.signedEntryTimestamp!, "base64")
        },
        inclusionProof: {
          logIndex: String(proof.logIndex),
          treeSize: String(proof.treeSize),
          rootHash: Buffer.from(proof.rootHash, "hex"),
          hashes: [],
          checkpoint: { envelope: proof.checkpoint! }
        }
      }
    ];
    return bundleToJSON(result);
  }
  return { trust, bundle };
}
