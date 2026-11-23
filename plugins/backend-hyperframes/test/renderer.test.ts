import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DockerExec, resolveRenderer } from "../src/render.js";

const RUNNER = new URL("../../../container/render-runner/", import.meta.url).pathname;
const SETTINGS = JSON.parse(readFileSync(join(RUNNER, "render-settings.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const ID = `sha256:${"a".repeat(64)}`;

/** A fake `docker`: `image inspect` gives the id, `run … --versions` gives `report`. */
function docker(report: unknown): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "image") return `${ID}\n`;
    if (args.at(-1) === "--versions") return `${JSON.stringify(report)}\n`;
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("resolveRenderer (M8.5, G10)", () => {
  it("reads the HyperFrames version and settings from the image, with no repository folder", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cw-no-runner-"));
    const { exec, calls } = docker({ hyperframes: "9.9.9", settings: { fps: 25 } });
    const info = await resolveRenderer("img", { exec, runnerDir: join(empty, "missing") });
    expect(info).toEqual({ image: ID, hyperframes: "9.9.9", settings: { fps: 25 } });
    const run = calls.find((c) => c[0] === "run") ?? [];
    expect(run).toEqual(expect.arrayContaining(["--rm", "--network", "none", "img", "--versions"]));
  });

  it("gives the same RendererInfo as the repository files for an image that reports them", async () => {
    const { exec } = docker({ hyperframes: MANIFEST.dependencies.hyperframes, settings: SETTINGS });
    const fromImage = await resolveRenderer("img", { exec, runnerDir: "/nowhere" });
    const fromRepo = await resolveRenderer("img", {
      exec: docker({ hyperframes: MANIFEST.dependencies.hyperframes }).exec,
      runnerDir: RUNNER,
    });
    expect(fromImage).toEqual(fromRepo);
  });

  it("falls back to the repository files for an image published before --versions had settings", async () => {
    const { exec } = docker({ hyperframes: "0.9.58", node: "24" });
    const info = await resolveRenderer("img", { exec, runnerDir: RUNNER });
    expect(info).toEqual({
      image: ID,
      hyperframes: MANIFEST.dependencies.hyperframes,
      settings: SETTINGS,
    });
  });

  it("says to update the image when it reports no settings and there is no repository folder", async () => {
    const { exec } = docker({ hyperframes: "0.9.58" });
    await expect(resolveRenderer("img", { exec, runnerDir: "/nowhere" })).rejects.toThrow(
      /reports no render settings.*newer image/,
    );
  });
});
