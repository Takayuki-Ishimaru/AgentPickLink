/**
 * Guards the assets referenced by the extension manifest and README, using only the files
 * distributed with the developer source. Checks dimensions, packaging and panel palette values.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface Manifest {
  icon?: string;
  galleryBanner?: { color?: string; theme?: string };
  files?: string[];
  contributes: { viewsContainers: { activitybar: Array<{ id: string; icon: string }> } };
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Manifest;
}

/**
 * `files` is an allow-list for both `npm pack` and `vsce package`: a path ships only when it, or a
 * directory above it, is listed. Glob entries (`dist/**`) are not expanded here -- the assets under
 * test are all plain directory entries.
 */
function isPackaged(manifest: Manifest, file: string): boolean {
  return (manifest.files ?? []).some(
    (entry) => file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`)
  );
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await fs.readFile(path.join(root, file));
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  // IHDR is always the first chunk: width and height are big-endian at bytes 16..23.
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("extension manifest brand assets", () => {
  it("ships a 256x256 colour PNG as the Marketplace icon", async () => {
    const manifest = await readManifest();
    const icon = manifest.icon ?? "";
    expect(icon).toBe("media/icon.png");
    expect(isPackaged(manifest, icon)).toBe(true);
    await expect(pngSize(icon)).resolves.toEqual({ width: 256, height: 256 });
    expect(manifest.galleryBanner).toEqual({ color: "#191827", theme: "dark" });
  });

  it("uses a single-colour 24x24 SVG for the activity bar container", async () => {
    const manifest = await readManifest();
    const [container] = manifest.contributes.viewsContainers.activitybar;
    expect(container.id).toBe("agentpicklink");
    expect(container.icon).toBe("media/activitybar.svg");
    expect(isPackaged(manifest, container.icon)).toBe(true);
    const svg = await fs.readFile(path.join(root, container.icon), "utf8");
    expect(svg).toMatch(/viewBox="0 0 24 24"/);
    expect(svg).not.toMatch(/<image\b/i);
    const colours = new Set(
      [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{3,8})"/gi)].map((match) => match[1].toLowerCase())
    );
    expect(colours.size).toBe(1);
  });

  it("references packaged 1600x480 header images from the README", async () => {
    const manifest = await readManifest();
    const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
    const headers = [...readme.matchAll(/media\/readme-header-(?:dark|light)\.png/g)].map(
      (match) => match[0]
    );
    expect(new Set(headers)).toEqual(
      new Set(["media/readme-header-dark.png", "media/readme-header-light.png"])
    );
    for (const header of new Set(headers)) {
      expect(isPackaged(manifest, header)).toBe(true);
      await expect(pngSize(header)).resolves.toEqual({ width: 1600, height: 480 });
    }
  });

  it("keeps the internal brand kit out of the package", async () => {
    const manifest = await readManifest();
    expect(isPackaged(manifest, "brand/README-ja.md")).toBe(false);
  });

  it("defines the panel palette with the expected public asset colors", async () => {
    const palette: Record<string, string> = {
      orange: "#FF6B1A",
      lavender: "#C6A7E8",
      blue: "#4057D6",
      black: "#191827",
      mist: "#F2EEF5"
    };
    const css = await fs.readFile(path.join(root, "media", "setup.css"), "utf8");
    expect(Object.keys(palette).sort()).toEqual(["black", "blue", "lavender", "mist", "orange"]);
    for (const [name, hex] of Object.entries(palette)) {
      const declared = new RegExp(`--brand-${name}:\\s*(#[0-9a-f]{6})\\s*;`, "i").exec(css)?.[1];
      expect(declared?.toLowerCase(), `--brand-${name}`).toBe(hex.toLowerCase());
    }
    // Use the palette's black instead of pure black.
    expect(css).not.toMatch(/#000(?:000)?\b/i);
  });
});
