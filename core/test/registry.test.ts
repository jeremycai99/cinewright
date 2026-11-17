import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hash } from "../src/canonical/hash.js";
import {
  profileRefPath,
  registryProfileNames,
  registryProfilesDir,
  UnknownProfileError,
} from "../src/registry/profiles.js";
import { validateDocument } from "../src/schema/validate.js";

const read = (name: string) =>
  JSON.parse(readFileSync(join(registryProfilesDir(), `${name}.json`), "utf8"));

describe("registry delivery profiles", () => {
  it("lists the v0 profiles by name", () => {
    expect(registryProfileNames()).toEqual(["landscape_web", "vertical_social"]);
  });

  it.each(["landscape_web", "vertical_social"])(
    "%s validates, hashes, and its id is its name",
    (name) => {
      const body = read(name);
      expect(validateDocument("delivery_profile", body)).toEqual([]);
      expect(body.id).toBe(name);
      expect(sha256Hash(body)).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
  );

  it("landscape_web is 1920x1080 at 30 fps with 42x2 captions", () => {
    const p = read("landscape_web");
    expect([p.width, p.height, p.frame_rate, p.sample_rate]).toEqual([
      1920,
      1080,
      { num: 30, den: 1 },
      48000,
    ]);
    expect(p.captions).toEqual({ max_chars_per_line: 42, max_lines: 2, min_display_frames: 30 });
    expect(p.loudness).toEqual({ integrated_lufs: -14, true_peak_dbtp: -1, tolerance_lu: 1 });
    expect(p.encoding.codec).toBe("libx264");
  });

  it("vertical_social is 1080x1920 with a larger bottom title-safe zone", () => {
    const p = read("vertical_social");
    expect([p.width, p.height, p.aspect_class]).toEqual([1080, 1920, "portrait"]);
    expect(p.captions.max_chars_per_line).toBe(32);
    expect(p.safe_zones.title.bottom).toBeGreaterThan(p.safe_zones.title.top);
  });
});

describe("profileRefPath", () => {
  it("resolves a bare name from the registry", () => {
    expect(profileRefPath("landscape_web", "/anywhere")).toBe(
      join(registryProfilesDir(), "landscape_web.json"),
    );
  });

  it("treats anything with a slash or .json as a path", () => {
    expect(profileRefPath("p/x.json", "/base")).toBe("/base/p/x.json");
    expect(profileRefPath("x.json", "/base")).toBe("/base/x.json");
  });

  it("rejects an unknown name, listing the known ones", () => {
    expect(() => profileRefPath("cinema_4k", "/base")).toThrow(UnknownProfileError);
    expect(() => profileRefPath("cinema_4k", "/base")).toThrow(
      "unknown delivery profile cinema_4k (known: landscape_web, vertical_social)",
    );
  });
});
