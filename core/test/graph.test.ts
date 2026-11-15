import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TokenTree } from "../src/cascade/resolve.js";
import { dependencyGraph, dirtyNodes, renderKey } from "../src/graph/deps.js";
import type { InlinedIr } from "../src/ir/inlined.js";
import { validateProject } from "../src/schema/validate.js";

const load = (file: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/graph/${file}`, import.meta.url)), "utf8"),
  );

// biome-ignore lint/suspicious/noExplicitAny: tests mutate the fixture freely
type Loose = any;

const PACK = load("pack.json") as TokenTree;
const INPUTS = {
  pack: PACK,
  componentVersions: { kinetic_title: "1.0.0", data_bars: "2.1.0" },
  backendVersion: "hyperframes-backend 0.1.0",
  containerDigest: "sha256:08a48730353f6f6739a7d1b5124b6779c3d5e7061c2d4a826364aa7d95eea51f",
};
const DELIVERABLES = ["web_landscape", "social_portrait"];

function fixture(): Loose {
  return load("ir.json");
}

function shotOf(ir: Loose, id: string): Loose {
  for (const scene of ir.sequences.value[0].scenes.value) {
    const found = scene.shots.value.find((s: Loose) => s.id === id);
    if (found) return found;
  }
  throw new Error(id);
}

const each = (prefix: string, ids: string[]) =>
  ids.flatMap((id) => DELIVERABLES.map((d) => `${prefix}${id}@${d}`));

describe("the graph fixture", () => {
  it("is a valid project", () => {
    expect(validateProject(fixture() as InlinedIr)).toEqual([]);
  });

  it("links lines, takes, anchors, durations, renders, transitions, mix, captions and assembly", () => {
    const graph = dependencyGraph(fixture(), INPUTS);
    expect(graph.edges.get("line:b01.l01")).toEqual(
      new Set([
        "take:take_l01",
        "anchors:a1",
        "anchors:a2",
        ...DELIVERABLES.map((d) => `captions@${d}`),
      ]),
    );
    expect(graph.edges.get("anchors:a2")).toEqual(new Set(["duration:a2"]));
    expect(graph.edges.get("render:a2@web_landscape")).toEqual(
      new Set(["transition:scene_a@web_landscape", "assembly@web_landscape"]),
    );
    expect(graph.edges.get("render:a1@web_landscape")).toEqual(new Set(["assembly@web_landscape"]));
    expect(graph.edges.get("render:b1@web_landscape")).toEqual(
      new Set(["transition:scene_a@web_landscape", "assembly@web_landscape"]),
    );
    expect(graph.nodes.has("transition:scene_b@web_landscape")).toBe(false); // a cut has no segment (D34)
  });
});

describe("dirtyNodes", () => {
  it("changing one shot dirties only its renders, its adjacent transition segments and the assembly", () => {
    const before = fixture();
    const after = fixture();
    shotOf(after, "a2").framing.value = "wide";
    expect(dirtyNodes(before, after, INPUTS)).toEqual(
      new Set([
        ...each("render:", ["a2"]),
        ...each("transition:", ["scene_a"]),
        ...DELIVERABLES.map((d) => `assembly@${d}`),
      ]),
    );
  });

  it("changing a shot inside a scene, away from transitions, dirties its renders and the assembly only", () => {
    const before = fixture();
    const after = fixture();
    shotOf(after, "a1").framing.value = "wide";
    expect(dirtyNodes(before, after, INPUTS)).toEqual(
      new Set([...each("render:", ["a1"]), ...DELIVERABLES.map((d) => `assembly@${d}`)]),
    );
  });

  it("changing a project-level token dirties every shot that uses it and no script, take or planning node", () => {
    const before = fixture();
    const after = fixture();
    after.style.overrides["palette.accent"].value = "#654321";
    const dirty = dirtyNodes(before, after, INPUTS);
    const renders = [...dirty].filter((n) => n.startsWith("render:"));
    expect(new Set(renders)).toEqual(new Set(each("render:", ["b1"])));
    expect([...dirty].filter((n) => /^(line:|take:|plan:|script$)/.test(n))).toEqual([]);
  });

  it("changing a line's text dirties its take, anchors, durations and everything downstream", () => {
    const before = fixture();
    const after = fixture();
    after.script.beats.value[0].lines.value[1].text.value = "Here is why, again.";
    const dirty = dirtyNodes(before, after, INPUTS);
    for (const node of [
      "line:b01.l02",
      "take:take_l02",
      "anchors:b1",
      "duration:b1",
      "anchors:b2",
      ...each("render:", ["b1", "b2"]),
      ...DELIVERABLES.map((d) => `mix@${d}`),
    ]) {
      expect(dirty, node).toContain(node);
    }
    expect(dirty).not.toContain("render:c1@web_landscape");
  });
});

describe("renderKey", () => {
  it("changes with the container digest, the backend version and the version of a component the shot uses", () => {
    const ir = fixture();
    const base = renderKey(ir, "b1", "web_landscape", INPUTS);
    expect(
      renderKey(ir, "b1", "web_landscape", {
        ...INPUTS,
        containerDigest: `sha256:${"1".repeat(64)}`,
      }),
    ).not.toBe(base);
    expect(renderKey(ir, "b1", "web_landscape", { ...INPUTS, backendVersion: "x" })).not.toBe(base);
    expect(
      renderKey(ir, "b1", "web_landscape", {
        ...INPUTS,
        componentVersions: { ...INPUTS.componentVersions, kinetic_title: "1.0.1" },
      }),
    ).not.toBe(base);
    expect(
      renderKey(ir, "b1", "web_landscape", {
        ...INPUTS,
        componentVersions: { ...INPUTS.componentVersions, data_bars: "9" },
      }),
    ).toBe(base);
    expect(renderKey(ir, "b1", "social_portrait", INPUTS)).not.toBe(base);
  });

  it("ignores authorship states and locks: they do not change what renders", () => {
    const before = fixture();
    const after = fixture();
    shotOf(after, "b1").framing.state = "locked";
    shotOf(after, "b1").locked = true;
    expect(renderKey(after, "b1", "web_landscape", INPUTS)).toBe(
      renderKey(before, "b1", "web_landscape", INPUTS),
    );
  });

  it("is the same for the same inputs, whatever the key order", () => {
    const ir = fixture();
    const expected = renderKey(ir, "b1", "web_landscape", INPUTS);
    const shuffle = (value: unknown, order: number[]): unknown => {
      if (Array.isArray(value)) return value.map((v) => shuffle(v, order));
      if (value === null || typeof value !== "object") return value;
      const keys = Object.keys(value);
      const rotated = keys.map(
        (_, i) => keys[(i + (order[i % order.length] ?? 0)) % keys.length] as string,
      );
      const unique = [...new Set([...rotated, ...keys])];
      return Object.fromEntries(
        unique.map((k) => [k, shuffle((value as Record<string, unknown>)[k], order)]),
      );
    };
    fc.assert(
      fc.property(fc.array(fc.nat(10), { minLength: 1, maxLength: 8 }), (order) => {
        expect(
          renderKey(shuffle(ir, order) as InlinedIr, "b1", "web_landscape", {
            ...INPUTS,
            pack: shuffle(PACK, order) as TokenTree,
          }),
        ).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  }, 60_000);
});
