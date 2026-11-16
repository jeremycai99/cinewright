import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/cli.js";
import { loadSettings } from "../src/settings.js";

const SETTINGS = new URL("../render-settings.json", import.meta.url);

function settingsFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "cw-settings-")), "render-settings.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("parseArgs", () => {
  it("reads --in and --out, defaulting to mp4", () => {
    expect(parseArgs(["--in", "a", "--out", "b"])).toEqual({
      input: "a",
      output: "b",
      format: "mp4",
    });
  });

  it("accepts --format png-sequence", () => {
    expect(parseArgs(["--in", "a", "--out", "b", "--format", "png-sequence"])).toEqual({
      input: "a",
      output: "b",
      format: "png-sequence",
    });
  });

  it("accepts --format mp4+frames and --fps", () => {
    expect(parseArgs(["--in", "a", "--out", "b", "--format", "mp4+frames", "--fps", "25"])).toEqual(
      {
        input: "a",
        output: "b",
        format: "mp4+frames",
        fps: 25,
      },
    );
  });

  it("accepts --body <start>,<end> with mp4+frames: the frames the MP4 holds", () => {
    expect(
      parseArgs(["--in", "a", "--out", "b", "--format", "mp4+frames", "--body", "6,72"]),
    ).toMatchObject({ format: "mp4+frames", body: { start: 6, end: 72 } });
    expect(() =>
      parseArgs(["--in", "a", "--out", "b", "--format", "mp4+frames", "--body", "72,6"]),
    ).toThrow(UsageError);
    expect(() => parseArgs(["--in", "a", "--out", "b", "--body", "0,6"])).toThrow(UsageError);
  });

  it("rejects a frame rate HyperFrames does not accept", () => {
    expect(() => parseArgs(["--in", "a", "--out", "b", "--fps", "29.97"])).toThrow(UsageError);
  });

  it("reads boxes --in --out --at --size --fps", () => {
    expect(
      parseArgs([
        "boxes",
        "--in",
        "a",
        "--out",
        "b",
        "--at",
        "0.5,1",
        "--size",
        "1080x1920",
        "--fps",
        "30",
      ]),
    ).toEqual({
      boxes: true,
      input: "a",
      output: "b",
      at: [0.5, 1],
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(() => parseArgs(["boxes", "--in", "a", "--out", "b", "--at", "1"])).toThrow(UsageError);
  });

  it("recognises --versions", () => {
    expect(parseArgs(["--versions"])).toEqual({ versions: true });
  });

  it("rejects a missing --out", () => {
    expect(() => parseArgs(["--in", "a"])).toThrow(UsageError);
  });

  it("rejects an unknown format", () => {
    expect(() => parseArgs(["--in", "a", "--out", "b", "--format", "gif"])).toThrow(UsageError);
  });
});

describe("loadSettings", () => {
  const valid = JSON.parse(readFileSync(SETTINGS, "utf8")) as Record<string, unknown>;

  it("loads the shipped settings", () => {
    expect(loadSettings(SETTINGS.pathname).encoder.threads).toBe(1);
  });

  it("rejects an unknown key", () => {
    expect(() => loadSettings(settingsFile({ ...valid, turbo: true }))).toThrow(
      /unknown key "turbo"/,
    );
  });

  it("rejects an unknown encoder key", () => {
    const encoder = { ...(valid.encoder as object), tune: "film" };
    expect(() => loadSettings(settingsFile({ ...valid, encoder }))).toThrow(
      /unknown key "encoder.tune"/,
    );
  });

  it("rejects strict and best_effort disagreeing", () => {
    expect(() => loadSettings(settingsFile({ ...valid, best_effort: true }))).toThrow(/strict/);
  });
});
