import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePackTokens } from "../src/cascade/resolve.js";
import type { DeliveryProfile } from "../src/generated/ir.js";
import { loadPack } from "../src/pack/load.js";
import { tokenEmit } from "../src/pack/tokens.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
const PROFILES = fileURLToPath(new URL("./fixtures/profiles/", import.meta.url));
const profile = (name: string): DeliveryProfile =>
  JSON.parse(readFileSync(join(PROFILES, `${name}.json`), "utf8"));

describe("tokenEmit", () => {
  const pack = loadPack("minimal", [FIXTURES]);
  const landscape = tokenEmit(resolvePackTokens(pack, "landscape"), profile("landscape_1080p30"));

  it("names CSS variables after the path, dots to dashes", () => {
    expect(landscape.css["--palette-accent"]).toBe("#0057B8");
    expect(landscape.css["--palette-data-1"]).toBe("#0057B8");
    expect(landscape.js["palette.accent"]).toBe("#0057B8");
  });

  it("turns dimensions into px of the shorter side, rounded to 0.01", () => {
    expect(landscape.css["--type-size-body"]).toBe("34.56px");
    expect(landscape.js["type.size.body"]).toBe(34.56);
    const portrait = tokenEmit(resolvePackTokens(pack, "portrait"), profile("portrait_1080p30"));
    expect(portrait.js["type.size.display"]).toBe(86.4);
    expect(portrait.js["layout.columns"]).toBe(4);
  });

  it("writes durations, fonts, easings, numbers, booleans and words for CSS and JS", () => {
    expect(landscape.css["--motion-duration-m"]).toBe("400ms");
    expect(landscape.js["motion.duration.m"]).toBe(400);
    expect(landscape.css["--type-family-body"]).toBe('"Test Sans", sans-serif');
    expect(landscape.js["type.family.body"]).toBe("Test Sans");
    expect(landscape.css["--motion-ease-enter"]).toBe("cubic-bezier(0, 0, 0, 1)");
    expect(landscape.css["--contrast-text_min"]).toBe("4.5");
    expect(landscape.css["--layout-columns"]).toBe("12");
    expect(landscape.css["--motion-preset-pop-enabled"]).toBe("0");
    expect(landscape.js["motion.preset.pop.enabled"]).toBe(false);
    expect(landscape.css["--motion-entrance"]).toBe('"rise"');
    expect(landscape.js["sound.music.genre"]).toBe("ambient");
  });
});
