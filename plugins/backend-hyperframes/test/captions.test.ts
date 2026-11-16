import { dirtyNodes, type TimingTable } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { planShot, shotRenderKey } from "../src/index.js";
import { catalog, pack, reference, timing, USER } from "./helpers.js";

const BURN = { op: "set", entity: "social_portrait", path: "/burn_in_captions", value: true };
const FULL = {
  op: "set",
  entity: "s03.sh02",
  path: "/layout/portrait",
  value: { template: "full" },
};

async function plan(
  shotId: string,
  deliverableId: string,
  table: TimingTable = timing(),
  ops: Record<string, unknown>[] = [BURN, FULL],
) {
  const store = await reference(ops);
  return planShot({
    ir: store.ir(),
    shotId,
    deliverableId,
    pack: pack("neutral"),
    catalog: catalog(),
    timing: table,
  });
}

const captionsOf = (p: Awaited<ReturnType<typeof plan>>) =>
  p.spec.layers.find((l) => l.component === "caption_track");

describe("burned-in captions (M3.4)", () => {
  it("adds a caption_track layer with cues from the timing table where the deliverable burns them in", async () => {
    const layer = captionsOf(await plan("s03.sh01", "social_portrait"));
    expect(layer?.id).toBe("s03.sh01.captions");
    expect(layer?.props).toEqual({
      cues: [{ text: "Every team hits the same wall.", start: 0, end: 60 }],
    });
    expect(layer?.timing).toEqual({ enter: 0, end: 75 });
    expect(layer?.captions).toEqual({
      max_chars_per_line: 32,
      max_lines: 2,
      min_display_frames: 30,
    });
  });

  it("adds none where the deliverable does not burn them in", async () => {
    expect(captionsOf(await plan("s03.sh01", "web_landscape"))).toBeUndefined();
  });

  it("splits a cue at a cut and draws both halves identically", async () => {
    const table = timing();
    (table.lines["b01.l01"] as { end: number }).end = 100;
    const a = captionsOf(await plan("s03.sh01", "social_portrait", table));
    const b = captionsOf(await plan("s03.sh02", "social_portrait", table));
    expect(a?.props).toEqual({
      cues: [{ text: "Every team hits the same wall.", start: 0, end: 75 }],
    });
    expect(b?.props).toEqual({
      cues: [
        { text: "Every team hits the same wall.", start: 0, end: 10 },
        { text: "We rebuilt it three times.", start: 0, end: 60 },
      ],
    });
    expect(b?.box).toEqual(a?.box);
    expect(b?.css).toEqual(a?.css);
    expect(b?.js).toEqual(a?.js);
  });

  it("a caption edit dirties only the shots it touches", async () => {
    const store = await reference([BURN, FULL]);
    const before = store.ir();
    await store.apply({
      base_revision: store.revision(),
      author: USER,
      mode: "apply",
      reason: "edit",
      ops: [{ op: "set", entity: "b01.l02", path: "/text", value: "We rebuilt it four times." }],
    });
    const after = store.ir();
    const renderer = { image: "sha256:1", hyperframes: "0.9.58", settings: {} };
    const key = async (ir: typeof before, shot: string) =>
      shotRenderKey(
        {
          ir,
          shotId: shot,
          deliverableId: "social_portrait",
          pack: pack("neutral"),
          catalog: catalog(),
          timing: timing(),
        },
        renderer,
      ).catch((e) => `error:${String(e)}`);
    const keys = new Map<string, string>();
    for (const [label, ir] of [
      ["before", before],
      ["after", after],
    ] as const)
      for (const shot of ["s03.sh01", "s03.sh02"])
        keys.set(`${label}:${shot}`, await key(ir, shot));
    const dirty = dirtyNodes(before, after, {
      pack: {},
      componentVersions: {},
      backendVersion: "",
      containerDigest: "",
      renderKey: (ir, shot, d) =>
        d === "social_portrait"
          ? (keys.get(`${ir === before ? "before" : "after"}:${shot}`) ?? "none")
          : "same",
    });
    expect(
      [...dirty].filter((n) => n.startsWith("render:") && n.endsWith("@social_portrait")).sort(),
    ).toEqual(["render:s03.sh02@social_portrait"]);
  });
});
