import { describe, expect, it } from "vitest";
import { run } from "./run.js";
import { golden, referenceCopy } from "./tree.js";

describe("cinewright show", () => {
  const cases: [string, string[]][] = [
    ["show-project.txt", []],
    ["show-scene.txt", ["s03_the_problem"]],
    ["show-scene-frames.txt", ["s03_the_problem", "--frames"]],
    ["show-scene-depth2.txt", ["s03_the_problem", "--depth", "2"]],
    ["show-shot.txt", ["s03.sh01"]],
    ["show-narrator.txt", ["narrator"]],
    ["show-dr-lin.txt", ["dr_lin"]],
  ];
  for (const [file, args] of cases) {
    it(`matches ${file}`, async () => {
      const dir = referenceCopy();
      const result = await run(["show", ...args, "--project", dir]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(golden(file, result.stdout));
    });
  }

  it("--json prints the stored form of the entity", async () => {
    const dir = referenceCopy();
    const result = await run(["show", "s03.sh02", "--project", dir, "--json"]);
    const shot = JSON.parse(result.stdout);
    expect(shot).toMatchObject({ id: "s03.sh02", subject: { value: "dr_lin", state: "user" } });
  });

  it("--resolved adds resolved tokens and fields with their origins", async () => {
    const dir = referenceCopy();
    const pack = `${dir}/pack.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      pack,
      JSON.stringify({ palette: { accent: "#000000" }, motion: { ease_out_expo: "ease-out" } }),
    );
    const result = await run([
      "show",
      "s03.sh01.title",
      "--project",
      dir,
      "--resolved",
      "--pack",
      pack,
      "--deliverable",
      "web_landscape",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("resolved for web_landscape:");
    expect(result.stdout).toContain('palette.accent: "#FF4D2E"  # scene s03_the_problem');
  });

  it("exits 3 for an unknown entity", async () => {
    expect((await run(["show", "nope", "--project", referenceCopy()])).code).toBe(3);
  });
});
