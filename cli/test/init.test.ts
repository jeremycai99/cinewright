import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";

const PROFILES = fileURLToPath(new URL("../../core/test/fixtures/profiles/", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cinewright init", () => {
  it("creates a project from two fixture profiles", async () => {
    const dir = join(tempDir(), "demo");
    const result = await run([
      "init",
      dir,
      "--id",
      "demo",
      "--deliverable",
      `web_landscape=${PROFILES}landscape_1080p30.json`,
      "--deliverable",
      `social_portrait=${PROFILES}portrait_1080p30.json`,
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(join(dir, "cinewright.json"))).toBe(true);
    const project = JSON.parse(readFileSync(join(dir, "cinewright.json"), "utf8"));
    expect(project.deliverables.value.map((d: { id: string }) => d.id)).toEqual([
      "web_landscape",
      "social_portrait",
    ]);
    expect(result.stdout).toContain("demo");
  });

  it("prints JSON with --json", async () => {
    const dir = join(tempDir(), "demo");
    const result = await run([
      "init",
      dir,
      "--id",
      "demo",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
      "--json",
    ]);
    expect(result.code).toBe(EXIT.ok);
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ status: "ok", revision: 0 });
    expect(out.state_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("resolves a registry profile by name", async () => {
    const dir = join(tempDir(), "demo");
    const result = await run([
      "init",
      dir,
      "--id",
      "demo",
      "--deliverable",
      "web=landscape_web",
      "--deliverable",
      "social=vertical_social",
    ]);
    expect(result.code).toBe(EXIT.ok);
    const project = JSON.parse(readFileSync(join(dir, "cinewright.json"), "utf8"));
    expect(Object.keys(project.profiles).sort()).toEqual(["landscape_web", "vertical_social"]);
  });

  it("exits 2 for an unknown profile name, listing the registry's names", async () => {
    const result = await run([
      "init",
      join(tempDir(), "demo"),
      "--id",
      "demo",
      "--deliverable",
      "web=cinema_4k",
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown delivery profile cinema_4k");
    expect(result.stderr).toContain("landscape_web, vertical_social");
  });

  it("exits 2 without a deliverable", async () => {
    const result = await run(["init", join(tempDir(), "demo"), "--id", "demo"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("--deliverable");
  });

  it("exits 3 with the validation errors for a bad project id", async () => {
    const result = await run([
      "init",
      join(tempDir(), "demo"),
      "--id",
      "Demo Project",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
      "--json",
    ]);
    expect(result.code).toBe(EXIT.invalid);
    expect(JSON.parse(result.stdout).errors).toContainEqual({
      entity: "Demo Project",
      pointer: "/id",
      rule: "schema.pattern",
    });
  });

  it("exits 2 for an unknown command", async () => {
    expect((await run(["frobnicate"])).code).toBe(EXIT.usage);
  });
});
