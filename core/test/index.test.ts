import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package wiring", () => {
  it("exports its version", () => {
    expect(VERSION).toBe("9.9.9");
  });
});
