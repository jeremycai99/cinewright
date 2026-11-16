import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { referenceCopy, tempDir } from "./tree.js";

describe("cinewright components", () => {
  it("lists the catalog with summaries", async () => {
    const result = await run(["components"]);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/\n {2}kinetic_title {2}A headline/);
  });

  it("prints one component's props and regions, and its entry as JSON", async () => {
    const text = (await run(["components", "kinetic_title"])).stdout;
    expect(text).toContain("  text  string  (required)");
    expect(text).toContain("  emphasis  list of integer");
    expect(text).toContain("  title: title");
    const json = JSON.parse((await run(["components", "kinetic_title", "--json"])).stdout);
    expect(json).toMatchObject({ id: "kinetic_title", runtime: "waapi" });
    expect(json.props.required).toEqual(["text"]);
    expect(json).not.toHaveProperty("dir");
  });

  it("exits 2 for an unknown component", async () => {
    expect((await run(["components", "nope"])).code).toBe(EXIT.usage);
  });
});

describe("patches are checked against the catalog", () => {
  it("rejects an unknown component", async () => {
    const dir = referenceCopy();
    const file = join(tempDir(), "bad-layer.json");
    writeFileSync(
      file,
      JSON.stringify({
        base_revision: 8,
        reason: "test",
        author: { kind: "user" },
        ops: [{ op: "set", entity: "s03.sh01.title", path: "/component", value: "nope" }],
      }),
    );
    const result = await run(["patch", "apply", "--project", dir, "--file", file, "--json"]);
    expect(result.code, result.stdout).toBe(EXIT.invalid);
    const rules = JSON.parse(result.stdout).errors.map((e: { rule: string }) => e.rule);
    expect(rules).toContain("semantic.unknown_component");
  });
});
