import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWork, jobOptions, outcomeAccepted } from "../src/render.js";
import { loadSettings } from "../src/settings.js";

const settings = loadSettings(new URL("../render-settings.json", import.meta.url).pathname);

describe("jobOptions", () => {
  it("passes the encoder options to an mp4 render", () => {
    expect(jobOptions(settings, "mp4")).toMatchObject({
      format: "mp4",
      quality: "standard",
      crf: 18,
      keyframeIntervalSeconds: 1,
    });
  });

  it("leaves mp4-only options out of a png-sequence render", () => {
    const frames = jobOptions({ ...settings, encode: "ffmpeg" }, "png-sequence");
    expect(frames.format).toBe("png-sequence");
    expect(frames).not.toHaveProperty("crf");
    expect(frames).not.toHaveProperty("keyframeIntervalSeconds");
  });
});

describe("outcomeAccepted", () => {
  it("accepts a clean render in either mode", () => {
    expect(outcomeAccepted("completed", true)).toBe(true);
    expect(outcomeAccepted("completed", false)).toBe(true);
  });

  it("accepts warnings only in best-effort mode", () => {
    expect(outcomeAccepted("completed_with_warnings", true)).toBe(false);
    expect(outcomeAccepted("completed_with_warnings", false)).toBe(true);
  });

  it("never accepts a failed or missing outcome", () => {
    expect(outcomeAccepted("failed", false)).toBe(false);
    expect(outcomeAccepted(undefined, false)).toBe(false);
  });
});

describe("copyWork", () => {
  it("copies the composition and adds nothing to it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-work-"));
    const input = join(root, "in");
    mkdirSync(input);
    writeFileSync(join(input, "index.html"), "<html></html>");
    const project = join(root, "work", "project");
    await copyWork(input, project);
    expect(readdirSync(project)).toEqual(["index.html"]);
    expect(existsSync(join(project, "vendor", "gsap.min.js"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
