import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { referenceCopy } from "./tree.js";

describe("cinewright mix", () => {
  it("needs a deliverable and an image", async () => {
    const dir = referenceCopy();
    expect((await run(["mix", "--project", dir], { CINEWRIGHT_IMAGE: "x" })).code).toBe(EXIT.usage);
    const noImage = await run(["mix", "--project", dir, "--deliverable", "web_landscape"], {
      CINEWRIGHT_IMAGE: "",
    });
    expect(noImage.code).toBe(EXIT.usage);
    expect(noImage.stderr).toContain("--image");
  });
});
