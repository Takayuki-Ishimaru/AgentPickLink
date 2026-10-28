import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installExtensionRelease } from "../../src/extension/extension-update.js";
import { createExtensionAttestationVerifier } from "../../src/services/extension-attestation.js";
import { attestationFixture, bytes, release, sourceCommit } from "../helpers/attestation-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock } from "./vscode-mock.js";

let fixture: Awaited<ReturnType<typeof attestationFixture>>;
let harness: RuntimeHarness;
beforeAll(async () => {
  fixture = await attestationFixture();
});
beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
});
afterEach(async () => {
  await harness.dispose();
});

function verify(bundle: unknown) {
  return vi.fn(
    createExtensionAttestationVerifier({
      fetchJSON: async (url) =>
        url.includes("/attestations/")
          ? { attestations: [{ bundle }] }
          : { ref: `refs/tags/${release.tag}`, object: { type: "commit", sha: sourceCommit } },
      trustMaterial: async () => fixture.trust
    })
  );
}

describe("signed artifact to native installation", () => {
  it("verifies a real signature before installing the same bytes and caching success", async () => {
    let installed = "0.2.98";
    let nativeBytes: Buffer | undefined;
    const verification = verify(await fixture.bundle());
    const download = vi.fn(async () => bytes);
    vscodeMock.commands.set("workbench.extensions.installExtension", async (uri: unknown) => {
      expect(verification).toHaveResolved();
      nativeBytes = await readFile((uri as { fsPath: string }).fsPath);
      installed = release.tag.slice(1);
    });
    const run = () =>
      installExtensionRelease(
        harness.context as never,
        release,
        new AbortController().signal,
        () => true,
        download,
        async () => installed,
        verification
      );

    expect(await run()).toBe(true);
    expect(nativeBytes).toEqual(bytes);
    expect(await run()).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    expect(verification).toHaveBeenCalledOnce();
    expect(vscodeMock.executedCommands).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(path.join(harness.context.globalStorageUri.fsPath, "installed-release.json"), "utf8")
    );
    expect(receipt).toMatchObject({ version: 2, attestation: { sourceCommit, sha256: release.sha256 } });
  });

  it("rejects a cryptographically signed foreign workflow without writing an install receipt", async () => {
    const verification = verify(
      await fixture.bundle({
        claims: {
          9: "https://github.com/attacker/repo/.github/workflows/release-build.yml@refs/tags/v0.2.99"
        }
      })
    );
    await expect(
      installExtensionRelease(
        harness.context as never,
        release,
        new AbortController().signal,
        () => true,
        async () => bytes,
        async () => "0.2.98",
        verification
      )
    ).rejects.toThrow("update-attestation-verification-failed");
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readdir(harness.context.globalStorageUri.fsPath)).toEqual([]);
  });
});
