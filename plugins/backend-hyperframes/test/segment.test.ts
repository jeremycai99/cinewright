import { dirtyNodes } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { CompileError, planShot, renderJobCommand, shotRenderKey } from "../src/index.js";
import { blendExpression, easingWeights } from "../src/segment.js";
import { catalog, pack, reference, segmentOps, timing, USER } from "./helpers.js";

async function plan(shotId: string, type: "cross_dissolve" | "wipe" | "cut", frames = 12) {
  const store = await reference(segmentOps(type, frames));
  return planShot({
    ir: store.ir(),
    shotId,
    deliverableId: "web_landscape",
    pack: pack("neutral"),
    catalog: catalog(),
    timing: timing(),
  });
}

describe("segments in the compiler (M3.3)", () => {
  it("extends the outgoing shot by d - h frames and suppresses exits that end at the cut", async () => {
    const p = await plan("s03.sh02", "cross_dissolve");
    expect(p.timeline).toEqual({ start: 90, before: 0, after: 6 });
    expect(p.frames).toBe(72 + 6);
    expect(p.segments.outgoing).toMatchObject({
      scene: "s03_the_problem",
      from: "s03.sh02",
      to: "s04.sh01",
      start: 156,
      end: 168,
      cut: 162,
    });
  });

  it("starts the incoming shot h frames early, with layers that start with it on from the overlap", async () => {
    const p = await plan("s04.sh01", "cross_dissolve");
    expect(p.timeline).toEqual({ start: 156, before: 6, after: 0 });
    expect(p.frames).toBe(66);
    // It starts with its shot, so it enters at the overlap's start: the transition is its entrance.
    expect(p.spec.layers[0]?.timing).toEqual({ enter: 0, end: 66 });
  });

  it("encodes only the body: the outgoing body stops at the segment, the incoming one starts after it", async () => {
    expect(renderJobCommand(await plan("s03.sh02", "cross_dissolve"))).toEqual(
      expect.arrayContaining(["--format", "mp4+frames", "--body", "0,72"]),
    );
    expect(renderJobCommand(await plan("s04.sh01", "cross_dissolve"))).toEqual(
      expect.arrayContaining(["--body", "6,66"]),
    );
    expect(renderJobCommand(await plan("s03.sh02", "cut"))).not.toContain("--body");
  });

  it("compiles a cut with no overlap", async () => {
    const p = await plan("s03.sh02", "cut");
    expect(p.timeline).toEqual({ start: 90, before: 0, after: 0 });
    expect(p.segments).toEqual({});
  });

  it("fails for a transition longer than either shot, naming the scene and both shots", async () => {
    const error = await plan("s03.sh02", "wipe", 61).catch((e) => e);
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).errors[0]).toMatchObject({
      entity: "s03_the_problem",
      rule: "compile.transition_too_long",
    });
    expect((error as Error).message).toContain("s03.sh02");
    expect((error as Error).message).toContain("s04.sh01");
  });

  it("suppresses the exit of a layer that ends at an outgoing transition", async () => {
    const store = await reference([
      ...segmentOps("cross_dissolve"),
      {
        op: "insert",
        entity: "s03.sh02",
        path: "/layers",
        value: {
          id: "s03.sh02.name",
          component: "lower_third",
          props: { name: "Dr Lin" },
          layout: { landscape: { region: "main" }, portrait: { region: "main" } },
        },
      },
    ]);
    const p = await planShot({
      ir: store.ir(),
      shotId: "s03.sh02",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
    });
    expect(p.spec.layers[0]?.timing).toEqual({ enter: 0, end: 78, exit: false });
  });
});

describe("segment blending", () => {
  it("eases from exactly 0 to exactly 1, never going back", () => {
    const w = easingWeights("cubic-bezier(0.2, 0, 0, 1)", 12);
    expect(w).toHaveLength(12);
    expect(w[0]).toBe(0);
    expect(w[11]).toBe(1);
    for (let i = 1; i < w.length; i += 1)
      expect(w[i] as number).toBeGreaterThanOrEqual(w[i - 1] as number);
    expect(easingWeights("linear", 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(easingWeights("linear", 1)).toEqual([1]);
  });

  it("writes a per-frame weight expression for a dissolve and an edge for a wipe", () => {
    const dissolve = blendExpression({ type: "cross_dissolve" }, [0, 0.5, 1]);
    expect(dissolve).toBe(
      "A*(1-(if(eq(N,0),0.000000,if(eq(N,1),0.500000,1.000000))))+B*(if(eq(N,0),0.000000,if(eq(N,1),0.500000,1.000000)))",
    );
    const wipe = blendExpression({ type: "wipe", direction: "left", softness: 0.15 }, [0, 1]);
    expect(wipe).toContain("clip((X-");
    expect(blendExpression({ type: "wipe", direction: "up", softness: 0 }, [0, 1])).toContain(
      "clip((Y-",
    );
  });
});

describe("segments in the dependency graph (M3.3)", () => {
  const RENDERER = { image: "sha256:1", hyperframes: "0.9.58", settings: {} };

  async function dirtyAfter(entity: string, path: string, value: unknown) {
    const store = await reference(segmentOps("cross_dissolve"));
    const before = store.ir();
    await store.apply({
      base_revision: store.revision(),
      author: USER,
      mode: "apply",
      reason: "edit",
      ops: [{ op: "set", entity, path, value }],
    });
    const after = store.ir();
    const keys = new Map<string, string>();
    for (const [label, ir] of [
      ["before", before],
      ["after", after],
    ] as const)
      for (const shot of ["s03.sh01", "s03.sh02", "s04.sh01"])
        keys.set(
          `${label}:${shot}`,
          await shotRenderKey(
            {
              ir,
              shotId: shot,
              deliverableId: "web_landscape",
              pack: pack("neutral"),
              catalog: catalog(),
              timing: timing(),
            },
            RENDERER,
          ),
        );
    const dirty = dirtyNodes(before, after, {
      pack: {},
      componentVersions: {},
      backendVersion: "",
      containerDigest: "",
      renderKey: (ir, shot, d) =>
        d === "web_landscape"
          ? (keys.get(`${ir === before ? "before" : "after"}:${shot}`) ?? "none")
          : "same",
    });
    return [...dirty]
      .filter(
        (n) =>
          n.endsWith("@web_landscape") && (n.startsWith("render:") || n.startsWith("transition:")),
      )
      .sort();
  }

  it("an edit to a shot next to a segment dirties that shot and the segment only", async () => {
    expect(await dirtyAfter("s04.sh01.title", "/props/text", "Here is the reason.")).toEqual([
      "render:s04.sh01@web_landscape",
      "transition:s03_the_problem@web_landscape",
    ]);
  });

  it("an edit to a shot away from every segment dirties that shot only", async () => {
    expect(await dirtyAfter("s03.sh01.title", "/props/text", "Every team hits a wall.")).toEqual([
      "render:s03.sh01@web_landscape",
    ]);
  });
});
