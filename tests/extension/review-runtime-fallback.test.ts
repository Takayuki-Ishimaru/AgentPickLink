import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  startUpdateCheck,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS
} from "../../src/extension/update-checker.js";
import { supportsExtensionAttestation } from "../../src/services/extension-attestation.js";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock } from "./vscode-mock.js";

const feed = [
  {
    tag_name: "v0.1.1",
    draft: false,
    assets: [
      {
        name: "agent-pick-link-0.1.1.vsix",
        state: "uploaded",
        digest: `sha256:${"a".repeat(64)}`,
        size: 4
      }
    ]
  }
];
const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
let harness: RuntimeHarness;
let disposable: { dispose(): void } | undefined;
beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness({ language: "en" });
  vi.useFakeTimers();
});
afterEach(async () => {
  disposable?.dispose();
  disposable = undefined;
  Object.defineProperty(process.versions, "node", nodeDescriptor);
  vi.useRealTimers();
  await harness.dispose();
});

it.each(["20.18.0", "22.22.1", "24.14.0"])(
  "offers a manual update without downloading on Node %s",
  async (version) => {
    Object.defineProperty(process.versions, "node", { ...nodeDescriptor, value: version });
    const deps = { fetch: vi.fn(async () => feed), install: vi.fn(async () => true) };
    disposable = startUpdateCheck(harness.context as never, harness.runtime, deps);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.install).not.toHaveBeenCalled();
    expect(vscodeMock.messages).toHaveLength(1);
    expect(vscodeMock.messages[0].message).toContain("v0.1.1");
    expect(vscodeMock.messages[0].items).toContain("Open release");
    expect(vscodeMock.messages[0].message).toContain("manually");
    await vi.advanceTimersByTimeAsync(4 * UPDATE_CHECK_INTERVAL_MS);
    expect(deps.install).not.toHaveBeenCalled();
    expect(vscodeMock.messages).toHaveLength(1);
  }
);

it.each([
  ["22.22.2", true],
  ["22.23.0", true],
  ["24.15.0", true],
  ["26.0.0", true],
  ["22.22.1", false],
  ["24.14.9", false],
  ["25.0.0", false],
  ["invalid", false]
] as const)("checks the attestation runtime boundary %s", (version, supported) => {
  expect(supportsExtensionAttestation(version)).toBe(supported);
});
