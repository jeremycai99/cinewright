import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrastPairs,
  contrastRatio,
  loadPack,
  type ResolvedToken,
  resolvePackTokens,
} from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { notIgnored } from "./ignored.js";

/** Every first-party pack: a folder in packs/ with a pack.json. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKS = notIgnored(ROOT, readdirSync(ROOT))
  .filter((name) => existsSync(join(ROOT, name, "pack.json")))
  .sort();

const DOMAINS = ["color", "type", "layout", "density", "motion", "transition", "sound"];

function increasing(tokens: Record<string, ResolvedToken>, paths: string[]): boolean {
  const values = paths.map((p) => tokens[p]?.value as number);
  return values.every((v, i) => i === 0 || v > (values[i - 1] as number));
}

describe("first-party packs", () => {
  it("exist", () => {
    expect(PACKS).toContain("neutral");
  });

  for (const id of PACKS) {
    describe(id, () => {
      const pack = loadPack(id, [ROOT]);

      for (const aspect of pack.manifest.aspect_classes) {
        describe(aspect, () => {
          const tokens = resolvePackTokens(pack, aspect);
          const value = (path: string) => tokens[path]?.value;

          it("meets every contrast pair at its minimum", () => {
            const failing = contrastPairs(tokens)
              .map((p) => ({
                ...p,
                ratio: contrastRatio(value(p.fg) as string, value(p.bg) as string),
              }))
              .filter((p) => p.ratio < p.min);
            expect(failing).toEqual([]);
          });

          it("has a strictly increasing type scale, no smaller than the minimum text size", () => {
            const sizes = ["caption", "small", "body", "subtitle", "title", "display"];
            expect(
              increasing(
                tokens,
                sizes.map((s) => `type.size.${s}`),
              ),
            ).toBe(true);
            expect(value("type.size.caption") as number).toBeGreaterThanOrEqual(
              value("density.min_text_size") as number,
            );
          });

          it("has a strictly increasing duration scale and no linear easing", () => {
            const steps = ["xs", "s", "m", "l", "xl"];
            expect(
              increasing(
                tokens,
                steps.map((s) => `motion.duration.${s}`),
              ),
            ).toBe(true);
            for (const ease of ["standard", "enter", "exit", "emphasis"])
              expect(value(`motion.ease.${ease}`), ease).not.toBe("linear");
          });

          it("names enabled presets and an enabled default transition", () => {
            for (const path of ["motion.entrance", "motion.exit"])
              expect(value(`motion.preset.${value(path)}.enabled`), path).toBe(true);
            const transition = value("transition.default");
            if (transition !== "cut") expect(value(`transition.${transition}.enabled`)).toBe(true);
          });

          it("has a music tempo range with min ≤ max", () => {
            expect(value("sound.music.bpm_min") as number).toBeLessThanOrEqual(
              value("sound.music.bpm_max") as number,
            );
          });
        });
      }

      it("has at least one rule per domain", () => {
        for (const domain of DOMAINS)
          expect(
            pack.rules.some((r) => r.id.startsWith(`${domain}.`)),
            domain,
          ).toBe(true);
      });

      it("keeps its rule ids (a removed id moves to retired_rules)", () => {
        expect({
          live: pack.rules.map((r) => r.id).sort(),
          retired: [...pack.manifest.retired_rules].sort(),
        }).toMatchSnapshot();
      });

      it("ships every font under OFL-1.1 with the licence text", () => {
        expect(pack.fonts.length).toBeGreaterThan(0);
        for (const font of pack.fonts) expect(font.license, font.file).toBe("OFL-1.1");
        expect(existsSync(join(pack.dir, "fonts", "OFL.txt"))).toBe(true);
      });
    });
  }

  it("documents the neutral pack as the neutral default", () => {
    const readme = readFileSync(join(ROOT, "neutral", "README.md"), "utf8");
    expect(readme).toMatch(/neutral default/i);
    for (const use of ["explainer", "lesson", "documentary", "product", "narrative"])
      expect(readme.toLowerCase(), use).toContain(use);
  });
});

describe("the contrasting pack (D39)", () => {
  it("exists", () => {
    expect(PACKS).toContain("playful");
  });
  if (!PACKS.includes("playful")) return;
  const neutral = resolvePackTokens(loadPack("neutral", [ROOT]), "landscape");
  const playful = resolvePackTokens(loadPack("playful", [ROOT]), "landscape");
  const differs = (path: string) => neutral[path]?.value !== playful[path]?.value;

  it("differs in type", () => {
    expect(differs("type.family.display")).toBe(true);
  });

  it("differs in palette: at least 4 of the 7 non-data roles", () => {
    const roles = ["bg", "surface", "ink", "ink_muted", "accent", "on_accent", "line"];
    expect(roles.filter((r) => differs(`palette.${r}`)).length).toBeGreaterThanOrEqual(4);
  });

  it("differs in motion grammar", () => {
    expect(differs("motion.ease.enter")).toBe(true);
    expect(neutral["motion.preset.pop.enabled"]?.value).toBe(false);
    expect(playful["motion.preset.pop.enabled"]?.value).toBe(true);
  });

  it("differs in transitions", () => {
    expect(differs("transition.default")).toBe(true);
  });

  it("differs in sound palette", () => {
    expect(differs("sound.music.genre")).toBe(true);
    expect(differs("sound.music.bpm_min") || differs("sound.music.bpm_max")).toBe(true);
  });
});
