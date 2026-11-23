import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The render-runner package root (works from `src/` under Vitest and from `dist/`). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** npm packages the image reports, by report key. They are direct dependencies of this package. */
const NPM_PACKAGES: Record<string, string> = { hyperframes: "hyperframes" };

/** Debian packages the image reports, by report key. */
const APT_PACKAGES: Record<string, string> = {
  ffmpeg: "ffmpeg",
  libx264: "libx264-164",
  python: "python3.13",
  "fonts-noto-core": "fonts-noto-core",
};

async function npmVersion(name: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "node_modules", name, "package.json"), "utf8"),
    ) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

async function aptVersion(name: string): Promise<string | undefined> {
  try {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a dpkg-query format, not a template
    const { stdout } = await run("dpkg-query", ["-W", "-f=${Version}", name]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function chromeVersion(): Promise<string | undefined> {
  const browser = process.env.HYPERFRAMES_BROWSER_PATH;
  if (!browser) return undefined;
  try {
    const { stdout } = await run(browser, ["--version"]);
    return /\d+\.\d+\.\d+\.\d+/.exec(stdout)?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Versions of everything the render depends on, as installed. A key is absent when the
 * component is not installed here (on a developer host only the npm keys resolve).
 */
export async function reportVersions(): Promise<Record<string, string>> {
  const found: [string, string | undefined][] = [["node", process.versions.node]];
  for (const [key, name] of Object.entries(NPM_PACKAGES)) found.push([key, await npmVersion(name)]);
  for (const [key, name] of Object.entries(APT_PACKAGES)) found.push([key, await aptVersion(name)]);
  found.push(["chrome_headless_shell", await chromeVersion()]);
  return Object.fromEntries(
    found.filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** `render-job --versions` (M8.5): the versions plus the render settings file as `settings`, so a
 * caller can key renders from the image alone (G10). */
export async function versionsReport(settingsPath: string): Promise<Record<string, unknown>> {
  return {
    ...(await reportVersions()),
    settings: JSON.parse(await readFile(settingsPath, "utf8")),
  };
}
