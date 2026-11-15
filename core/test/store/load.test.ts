import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectLoadError, Store } from "../../src/store/store.js";
import { OPTIONS, setupProject } from "./helpers.js";

describe("a file edited outside the store", () => {
  it("fails to load, naming the file and the changed entity", async () => {
    const { dir } = await setupProject();
    const file = join(dir, "sequences", "seq_main.json");
    const seq = JSON.parse(readFileSync(file, "utf8"));
    seq.scenes.value[0].shots.value[0].framing.value = "close_up";
    writeFileSync(file, `${JSON.stringify(seq, null, 2)}\n`);
    const error = await Store.open(dir, OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectLoadError);
    expect(error).toMatchObject({
      file: "sequences/seq_main.json",
      entity: "s01.sh01",
      pointer: "/framing",
    });
  });

  it("fails when only the formatting changed", async () => {
    const { dir } = await setupProject();
    const file = join(dir, "cinewright.json");
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8"))));
    await expect(Store.open(dir, OPTIONS)).rejects.toMatchObject({ file: "cinewright.json" });
  });
});
