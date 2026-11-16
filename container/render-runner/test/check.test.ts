import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkArgs, failures } from "../src/check.js";
import { parseArgs, UsageError } from "../src/cli.js";
import { moveFile } from "../src/render.js";

describe("render-job check arguments", () => {
  it("reads --in, --out and --at", () => {
    expect(parseArgs(["check", "--in", "a", "--out", "b", "--at", "0.5,1.5"])).toEqual({
      check: true,
      input: "a",
      output: "b",
      at: [0.5, 1.5],
    });
  });

  it("needs --at, numbers only, and no render flags", () => {
    expect(() => parseArgs(["check", "--in", "a", "--out", "b"])).toThrow(/--at is required/);
    expect(() => parseArgs(["check", "--in", "a", "--out", "b", "--at", "1,x"])).toThrow(
      UsageError,
    );
    expect(() =>
      parseArgs(["check", "--in", "a", "--out", "b", "--at", "1", "--format", "mp4"]),
    ).toThrow(/unknown argument "--format"/);
  });

  it("calls HyperFrames check with every option explicit", () => {
    expect(checkArgs("/tmp/p", [0.5, 1.5])).toEqual([
      "check",
      "/tmp/p",
      "--json",
      "--strict",
      "--no-craft",
      "--no-cache",
      "--no-browser-gpu",
      "--at",
      "0.5,1.5",
    ]);
  });
});

describe("failures", () => {
  const clean = {
    ok: true,
    lint: { findings: [] },
    runtime: { findings: [] },
    layout: { findings: [] },
    contrast: { findings: [] },
  };

  it("passes a clean report", () => {
    expect(failures(clean)).toEqual([]);
  });

  it("fails on any error or warning in lint, runtime, layout or contrast, and ignores infos", () => {
    const report = {
      ...clean,
      contrast: {
        findings: [
          {
            code: "contrast_aa_failure",
            severity: "warning",
            message: "Contrast is 1:1; WCAG AA requires 3:1.",
            selector: "div > span",
            time: 1.5,
          },
          { code: "x", severity: "info", message: "fyi", selector: "p", time: 2 },
        ],
      },
    };
    expect(failures(report)).toEqual([
      {
        section: "contrast",
        code: "contrast_aa_failure",
        severity: "warning",
        message: "Contrast is 1:1; WCAG AA requires 3:1.",
        selector: "div > span",
        time: 1.5,
      },
    ]);
  });

  it("names a component marker reported through the console after its marker", () => {
    const report = {
      ...clean,
      ok: false,
      runtime: {
        findings: [
          {
            code: "console_warning",
            severity: "warning",
            message: "cinewright.density layer=bullet_reveal.too_many element=div.cw-bullet-reveal",
            selector: "[data-composition-id]",
            time: 0,
          },
        ],
      },
    };
    expect(failures(report)).toEqual([
      {
        section: "runtime",
        code: "cinewright.density",
        severity: "warning",
        message: "cinewright.density layer=bullet_reveal.too_many element=div.cw-bullet-reveal",
        selector: "[data-composition-id]",
        time: 0,
      },
    ]);
  });

  it("fails a report that is not ok even without findings", () => {
    expect(failures({ ...clean, ok: false })).toEqual([
      {
        section: "report",
        code: "not_ok",
        severity: "error",
        message: "the check report is not ok",
      },
    ]);
  });
});

describe("moveFile", () => {
  it("copies and removes the source when rename crosses devices (EXDEV)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-move-"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "a.png"), "pixels");
    const crossDevice = async () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    };
    await moveFile(join(dir, "a.png"), join(dir, "out", "000001.png"), crossDevice);
    expect(readFileSync(join(dir, "out", "000001.png"), "utf8")).toBe("pixels");
    expect(existsSync(join(dir, "a.png"))).toBe(false);
  });
});
