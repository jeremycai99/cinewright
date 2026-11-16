import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { irFiles, patch, setupProject } from "./helpers.js";

describe("ids that would escape the project directory", () => {
  for (const id of ["../x", "a/b", "CON", "Shot1", "seq main", ""]) {
    it(`rejects ${JSON.stringify(id)} before writing anything`, async () => {
      const { dir, store } = await setupProject();
      const before = irFiles(dir);
      const result = await store.apply(
        patch(store, [
          { op: "insert", entity: "demo", path: "/sequences", value: { id, title: "Bad" } },
        ]),
      );
      expect(result.status).toBe("rejected");
      expect(irFiles(dir)).toEqual(before);
      expect(existsSync(join(dir, "x.json"))).toBe(false);
      expect(existsSync(join(dirname(dir), "x.json"))).toBe(false);
      expect(existsSync(join(dir, "sequences", "a"))).toBe(false);
    });
  }
});
