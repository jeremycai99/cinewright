import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hash } from "../src/canonical/hash.js";
import type { InlinedIr } from "../src/ir/inlined.js";
import { validateProject } from "../src/schema/validate.js";

const REFERENCE = fileURLToPath(new URL("./fixtures/ir/reference.json", import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: tests mutate the fixture freely
type Loose = any;

function reference(): Loose {
  return JSON.parse(readFileSync(REFERENCE, "utf8"));
}

function scene(ir: Loose): Loose {
  return ir.sequences.value[0].scenes.value[0];
}

function shots(ir: Loose): Loose[] {
  return scene(ir).shots.value;
}

describe("validateProject", () => {
  it("accepts the reference IR (the spec's scene and cast examples)", () => {
    expect(validateProject(reference() as InlinedIr)).toEqual([]);
  });

  it("reports an id used twice, across kinds", () => {
    const ir = reference();
    shots(ir)[0].layers.value[1].id = "narrator";
    expect(validateProject(ir)).toEqual([
      { entity: "narrator", pointer: "", rule: "semantic.duplicate_id" },
    ]);
  });

  it("reports a reference that does not resolve", () => {
    const ir = reference();
    scene(ir).lines.value.push("b09.l09");
    expect(validateProject(ir)).toEqual([
      { entity: "s03_the_problem", pointer: "/lines/value/2", rule: "semantic.dangling_ref" },
    ]);
  });

  it("reports a reference to the wrong kind of entity", () => {
    const ir = reference();
    ir.script.beats.value[0].lines.value[0].speaker.value = "s03.sh01";
    expect(validateProject(ir)).toEqual([
      { entity: "b01.l01", pointer: "/speaker/value", rule: "semantic.ref_kind" },
    ]);
  });

  it("reports deliverables with two frame rates", () => {
    const ir = reference();
    const copy = ir.profiles.portrait_1080p30;
    copy.body.frame_rate = { num: 25, den: 1 };
    copy.hash = sha256Hash(copy.body);
    expect(validateProject(ir)).toEqual([
      { entity: "demo", pointer: "/deliverables", rule: "semantic.frame_rate_mismatch" },
    ]);
  });

  it("reports a deliverable whose profile is not in the project", () => {
    const ir = reference();
    ir.deliverables.value[1].profile.value = "square_1080p30";
    expect(validateProject(ir)).toEqual([
      { entity: "social_portrait", pointer: "/profile/value", rule: "semantic.unknown_profile" },
    ]);
  });

  it("reports a profile copy whose hash does not match its body", () => {
    const ir = reference();
    ir.profiles.portrait_1080p30.hash = `sha256:${"0".repeat(64)}`;
    expect(validateProject(ir)).toEqual([
      { entity: "demo", pointer: "/profiles/portrait_1080p30/hash", rule: "semantic.profile_hash" },
    ]);
  });

  it("reports an id that was used before and retired", () => {
    expect(validateProject(reference(), { retiredIds: new Set(["s03.sh02"]) })).toEqual([
      { entity: "s03.sh02", pointer: "", rule: "semantic.id_reused" },
    ]);
  });

  it("reports a word anchor without a word index", () => {
    const ir = reference();
    shots(ir)[1].anchors.value.start = { line: "b01.l02", point: "word", offset: 0 };
    expect(validateProject(ir)).toEqual([
      { entity: "s03.sh02", pointer: "/anchors/value/start", rule: "anchor.word_presence" },
    ]);
  });

  it("reports schema errors inside a sequence with the sequence's entities", () => {
    const ir = reference();
    shots(ir)[1].type.value = "hologram";
    expect(validateProject(ir)).toEqual([
      { entity: "s03.sh02", pointer: "/type/value", rule: "schema.enum" },
    ]);
  });
});
