import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { REFERENCE, referenceCopy, tempDir } from "./tree.js";

const TIMING = join(REFERENCE, "timing.json");
const PLUGINS = new URL("../../engine/test/fixtures/plugins/", import.meta.url).pathname;
const REGIONS = new URL(
  "../../plugins/backend-hyperframes/test/fixtures/regions.json",
  import.meta.url,
).pathname;

async function placed(): Promise<string> {
  const dir = referenceCopy();
  const regions = JSON.parse(readFileSync(REGIONS, "utf8"));
  const status = await run(["status", "--project", dir, "--json"]);
  regions.base_revision = JSON.parse(status.stdout).revision;
  const file = join(tempDir(), "regions.json");
  await import("node:fs").then((fs) => fs.writeFileSync(file, JSON.stringify(regions)));
  const applied = await run(["patch", "apply", "--project", dir, "--file", file]);
  expect(applied.code, applied.stderr).toBe(EXIT.ok);
  return dir;
}

describe("cinewright compile", () => {
  it("writes the composition for one shot and deliverable", async () => {
    const dir = await placed();
    const out = join(tempDir(), "out");
    const result = await run([
      "compile",
      "s03.sh01",
      "--deliverable",
      "web_landscape",
      "--timing",
      TIMING,
      "--out",
      out,
      "--project",
      dir,
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", dir: out, frames: 75 });
  });

  it("exits 3 with every compile error, naming layer and field", async () => {
    const dir = referenceCopy();
    const result = await run([
      "compile",
      "s03.sh01",
      "--deliverable",
      "web_landscape",
      "--timing",
      TIMING,
      "--out",
      join(tempDir(), "o"),
      "--project",
      dir,
    ]);
    expect(result.code).toBe(EXIT.invalid);
    expect(result.stderr).toContain("s03.sh01.title /layout/landscape: compile.unknown_region");
  });

  it("uses the solved timing without --timing (M4.2)", async () => {
    const dir = await placed();
    const status = await run(["status", "--project", dir, "--json"]);
    const bind = join(tempDir(), "bind.json");
    writeFileSync(
      bind,
      JSON.stringify({
        base_revision: JSON.parse(status.stdout).revision,
        author: { kind: "user" },
        mode: "apply",
        reason: "bind the stub voice",
        ops: [
          { op: "set", entity: "dr_lin", path: "/voice/description", value: { language: "en" } },
          ...["narrator", "dr_lin"].map((id) => ({
            op: "set",
            entity: id,
            path: "/voice/bindings/stub_tts_a",
            value: { voice: "test" },
          })),
        ],
      }),
    );
    expect((await run(["patch", "apply", "--project", dir, "--file", bind])).code).toBe(EXIT.ok);
    const narrated = await run(["narrate", "--project", dir, "--plugins", PLUGINS]);
    expect(narrated.code, narrated.stderr).toBe(EXIT.ok);
    const solved = JSON.parse((await run(["timing", "--project", dir, "--json"])).stdout);
    const span = solved.shots["s03.sh01"];
    const result = await run([
      "compile",
      "s03.sh01",
      "--deliverable",
      "web_landscape",
      "--out",
      join(tempDir(), "o"),
      "--project",
      dir,
      "--json",
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout).frames).toBe(span.end - span.start);
  });
});

describe("cinewright render-shot", () => {
  it("rejects a shot id that is not an entity id before touching any file", async () => {
    const dir = await placed();
    // render-shot clears .cinewright/compiled/<shot>.<deliverable>; "../../victim" would reach here.
    const victim = join(dir, "victim.web_landscape");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "x");
    const result = await run([
      "render-shot",
      "../../victim",
      "--deliverable",
      "web_landscape",
      "--timing",
      TIMING,
      "--image",
      "x",
      "--project",
      dir,
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });

  it("exits 2 without an image", async () => {
    const dir = await placed();
    const result = await run(
      [
        "render-shot",
        "s03.sh01",
        "--deliverable",
        "web_landscape",
        "--timing",
        TIMING,
        "--project",
        dir,
      ],
      { CINEWRIGHT_IMAGE: "" },
    );
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("--image");
  });

  it("exits 3 for a shot that does not compile, before running anything", async () => {
    const dir = referenceCopy();
    const result = await run([
      "render-shot",
      "s03.sh01",
      "--deliverable",
      "web_landscape",
      "--timing",
      TIMING,
      "--image",
      "x",
      "--project",
      dir,
    ]);
    expect(result.code).toBe(EXIT.invalid);
    expect(result.stderr).toContain("compile.unknown_region");
  });
});
