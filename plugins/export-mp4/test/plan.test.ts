import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InlinedIr } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { FLAGS } from "../src/assemble.js";
import { AssemblyError, assemblyKey, type Part, planAssembly } from "../src/plan.js";

const IR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../core/test/fixtures/ir/reference.json", import.meta.url)),
    "utf8",
  ),
) as InlinedIr;
// The fixture's profile copies predate the encoding block (M5): give the landscape one the
// registry's encoding.
const ENCODING = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../registry/profiles/landscape_web.json", import.meta.url)),
    "utf8",
  ),
).encoding;
for (const copy of Object.values(IR.profiles)) copy.body.encoding = ENCODING;
const fps = { num: 30, den: 1 };
const parts: Part[] = [
  { kind: "body", id: "s01.sh01", key: "a", file: "/a.mp4", frames: 60 },
  { kind: "segment", id: "s01", key: "s", file: "/s.mp4", frames: 12 },
  { kind: "body", id: "s02.sh01", key: "b", file: "/b.mp4", frames: 48 },
];
const solved = { table: { fps, lines: {} }, frames: 120 };
const mix = { key: "m", file: "/m.wav", samples: 120 * 1600 };
const plan = () => planAssembly({ ir: IR, deliverableId: "web_landscape", solved, parts, mix });

describe("planAssembly (M5.1)", () => {
  it("takes the parts in order, the profile's audio encoding and loudness targets", () => {
    expect(plan()).toMatchObject({
      frames: 120,
      parts: parts.map((p) => ({ id: p.id })),
      audio: { codec: "aac", bitrate_kbps: 384 },
      targets: { integrated_lufs: -14, true_peak_dbtp: -1 },
      mix: { sample_rate: 48000 },
    });
  });

  it("refuses parts that do not add up to the timeline, and a mix of the wrong length", () => {
    const short = () =>
      planAssembly({ ir: IR, deliverableId: "web_landscape", solved, parts: parts.slice(1), mix });
    expect(short).toThrow(AssemblyError);
    expect(short).toThrow(/the parts have 60 frames; the timeline has 120/);
    const long = () =>
      planAssembly({
        ir: IR,
        deliverableId: "web_landscape",
        solved,
        parts,
        mix: { ...mix, samples: mix.samples + 1 },
      });
    expect(long).toThrow(/192001 samples; 120 frames need 192000/);
    expect(() =>
      planAssembly({ ir: IR, deliverableId: "web_landscape", solved, parts: [], mix }),
    ).toThrow(/no parts/);
  });
});

describe("the assembly key and flags", () => {
  it("changes with any part key, the mix, the audio bitrate or the image, and not with paths", () => {
    const k = assemblyKey(plan(), "img", FLAGS);
    const moved = {
      ...plan(),
      parts: plan().parts.map((p) => ({ ...p, file: `/elsewhere${p.file}` })),
    };
    expect(assemblyKey(moved, "img", FLAGS)).toBe(k);
    const otherPart = {
      ...plan(),
      parts: plan().parts.map((p, i) => (i === 1 ? { ...p, key: "s2" } : p)),
    };
    expect(assemblyKey(otherPart, "img", FLAGS)).not.toBe(k);
    expect(assemblyKey({ ...plan(), mix: { ...plan().mix, key: "m2" } }, "img", FLAGS)).not.toBe(k);
    expect(
      assemblyKey({ ...plan(), audio: { codec: "aac", bitrate_kbps: 256 } }, "img", FLAGS),
    ).not.toBe(k);
    expect(assemblyKey(plan(), "img2", FLAGS)).not.toBe(k);
  });

  it("copies video and names no video encoder (D34)", () => {
    expect(FLAGS.video).toEqual(["-c", "copy"]);
    const all = JSON.stringify(FLAGS);
    expect(all).not.toMatch(/libx264|-c:v (?!copy)|-crf/);
  });
});
