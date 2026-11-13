import { describe, expect, it } from "vitest";
import { jobOptions } from "../src/render.js";
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
