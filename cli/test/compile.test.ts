import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { REFERENCE, referenceCopy, tempDir } from "./tree.js";

const TIMING = join(REFERENCE, "timing.json");
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

  it("exits 2 without --timing", async () => {
    const dir = await placed();
    const result = await run([
      "compile",
      "s03.sh01",
      "--deliverable",
      "web_landscape",
      "--out",
      join(tempDir(), "o"),
      "--project",
      dir,
    ]);
    expect(result.code).toBe(EXIT.usage);
  });
});

describe("cinewright render-shot", () => {
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
