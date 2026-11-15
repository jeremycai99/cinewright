import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReference, REFERENCE, tree } from "./tree.js";

describe("the M1 reference project", () => {
  it("built with only init, patch and show, is byte-identical to the checked-in project, logs included", () => {
    const built = tree(buildReference());
    const expected = tree(join(REFERENCE, "project"));
    expect([...built.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, text] of expected) expect(built.get(file), file).toBe(text);
  }, 60_000);
});
