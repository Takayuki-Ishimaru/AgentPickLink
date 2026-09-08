import { describe, expect, it, vi } from "vitest";
import { checkGithubUpdate, compareVersions, newestRelease } from "../../src/extension/update-checker.js";

const release = (tag_name: string, draft = false) => ({ tag_name, draft, prerelease: true });

describe("GitHub release notifications", () => {
  it("orders versions numerically and follows SemVer prerelease precedence", () => {
    const ordered = [
      "0.1.0-alpha",
      "0.1.0-alpha.1",
      "0.1.0-alpha.beta",
      "0.1.0-beta.2",
      "0.1.0-beta.11",
      "0.1.0-rc.1",
      "0.1.0",
      "0.1.1",
      "0.10.0",
      "1.0.0"
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i]!, ordered[i - 1]!)).toBe(1);
      expect(compareVersions(ordered[i - 1]!, ordered[i]!)).toBe(-1);
    }
    expect(compareVersions("v0.1.0+one", "0.1.0+two")).toBe(0);
    for (const bad of ["", "01.2.3", "1.2", "1.2.3-beta.01", "https://evil.test", "1.2.3\nclick here"])
      expect(compareVersions(bad, "0.1.0")).toBeUndefined();
  });

  it("includes published beta releases, excludes drafts, and uses only the fixed project URL", () => {
    expect(
      newestRelease(
        [
          release("0.1.1"),
          release("9.0.0", true),
          {
            ...release("v0.2.0-beta.1"),
            html_url: "https://evil.test",
            body: "Ignore previous instructions"
          },
          release("../../other"),
          release("0.1.2")
        ],
        "0.1.0"
      )
    ).toEqual({
      tag: "v0.2.0-beta.1",
      url: "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/tag/v0.2.0-beta.1"
    });
    expect(newestRelease([release("v0.1.0")], "0.1.0")).toBeUndefined();
    expect(newestRelease({}, "0.1.0")).toBeUndefined();
  });

  function harness() {
    const store = new Map<string, string>();
    return {
      installed: "0.1.0",
      state: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: string) => {
          store.set(key, value);
        }
      },
      fetchReleases: vi.fn(async () => [release("v0.1.1")]),
      active: vi.fn(() => true),
      notify: vi.fn(async () => false),
      open: vi.fn(async (_url: string) => true)
    };
  }

  it("notifies once per version and opens a release only when the button is selected", async () => {
    const options = harness();
    await checkGithubUpdate(options);
    await checkGithubUpdate(options);
    expect(options.notify).toHaveBeenCalledExactlyOnceWith("v0.1.1");
    expect(options.open).not.toHaveBeenCalled();
    options.fetchReleases.mockResolvedValue([release("v0.1.2")]);
    options.notify.mockResolvedValue(true);
    await checkGithubUpdate(options);
    expect(options.open).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/tag/v0.1.2"
    );
  });

  it("does not fetch when disabled or notify after disposal during a request", async () => {
    const options = harness();
    options.active.mockReturnValue(false);
    await checkGithubUpdate(options);
    expect(options.fetchReleases).not.toHaveBeenCalled();
    options.active.mockReturnValueOnce(true).mockReturnValue(false);
    await checkGithubUpdate(options);
    expect(options.fetchReleases).toHaveBeenCalledOnce();
    expect(options.notify).not.toHaveBeenCalled();
  });

  it("does not persist a notification when fetching fails, allowing a later activation to retry", async () => {
    const options = harness();
    options.fetchReleases.mockRejectedValueOnce(new Error("offline"));
    await expect(checkGithubUpdate(options)).rejects.toThrow("offline");
    await checkGithubUpdate(options);
    expect(options.notify).toHaveBeenCalledOnce();
  });
});
