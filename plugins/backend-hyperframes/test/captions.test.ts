import { breakCaption } from "@cinewright/components";
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
    // The compiler applies the profile's minimum display time itself (audit G3), so the
    // component adds none.
    expect(layer?.captions).toEqual({
      max_chars_per_line: 32,
      max_lines: 2,
      min_display_frames: 0,
    });
  });

  it("adds none where the deliverable does not burn them in", async () => {
    expect(captionsOf(await plan("s03.sh01", "web_landscape"))).toBeUndefined();
  });

  it("splits a cue at a cut and draws both halves identically", async () => {
    // The cut at frame 90 falls inside the first line, which now runs to 100; the second line
    // follows it, so the two cues never overlap (audit G3).
    const table = timing();
    (table.lines["b01.l01"] as { end: number }).end = 100;
    (table.lines["b01.l02"] as { start: number }).start = 100;
    const ops = [
      BURN,
      FULL,
      {
        op: "set",
        entity: "s03.sh02",
        path: "/anchors",
        value: {
          start: { line: "b01.l01", point: "end", offset: -10 },
          end: { line: "b01.l02", point: "end", offset: 12 },
        },
      },
    ];
    const a = captionsOf(await plan("s03.sh01", "social_portrait", table, ops));
    const b = captionsOf(await plan("s03.sh02", "social_portrait", table, ops));
    expect(a?.props).toEqual({
      cues: [{ text: "Every team hits the same wall.", start: 0, end: 75 }],
    });
    expect(b?.props).toEqual({
      cues: [
        { text: "Every team hits the same wall.", start: 0, end: 10 },
        { text: "We rebuilt it three times.", start: 10, end: 60 },
      ],
    });
    expect(b?.box).toEqual(a?.box);
    expect(b?.css).toEqual(a?.css);
    expect(b?.js).toEqual(a?.js);
  });

  it("takes cues only from the shot's own sequence", async () => {
    const table = timing();
    table.lines["b02.l01"] = { start: 20, end: 40, words: [{ start: 20, end: 40 }] };
    const layer = captionsOf(
      await plan("s03.sh01", "social_portrait", table, [
        BURN,
        FULL,
        {
          op: "insert",
          entity: "script",
          path: "/beats",
          value: {
            id: "b02",
            summary: "Other",
            lines: [{ id: "b02.l01", text: "Elsewhere.", speaker: "narrator" }],
          },
        },
        {
          op: "insert",
          entity: "demo",
          path: "/sequences",
          value: {
            id: "seq_b",
            title: "B",
            scenes: [{ id: "sb1", intent: "Other", lines: ["b02.l01"] }],
          },
        },
      ]),
    );
    expect(((layer?.props.cues ?? []) as { text: string }[]).map((c) => c.text)).toEqual([
      "Every team hits the same wall.",
    ]);
  });

  it("splits a line too long for the caption rules at word timings, so no cue overflows", async () => {
    const text = "Continuous integration pipelines inevitably accumulate complexity.";
    const layer = captionsOf(
      await plan("s03.sh01", "social_portrait", timing(), [
        BURN,
        FULL,
        { op: "set", entity: "b01.l01", path: "/text", value: text },
      ]),
    );
    const cues = layer?.props.cues as { text: string; start: number; end: number }[];
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((c) => c.text).join(" ")).toBe(text);
    // Words start at 15, 25, 34, 43, 50, 59 on the timeline; the shot starts at 15.
    expect(cues[0]?.start).toBe(0);
    // The last piece starts at 44 and is held for 30 frames, ending before the next line (75).
    expect(cues.at(-1)?.end).toBe(74);
    for (const [i, cue] of cues.entries()) {
      expect(breakCaption(cue.text, 32, 2).overflow).toBe(false);
      if (i > 0) expect(cue.start).toBe(cues[i - 1]?.end);
      expect([0, 10, 19, 28, 35, 44]).toContain(cue.start);
    }
  });

  it("holds a short cue for the minimum display time, but never past the next cue (audit G3)", async () => {
    const table = timing();
    // "Every team…" is spoken over [15, 20); a short line follows 10 frames later, inside the shot.
    table.lines["b01.l01"] = {
      ...(table.lines["b01.l01"] as TimingTable["lines"][string]),
      end: 20,
    };
    table.lines["b01.l03"] = { start: 25, end: 70, words: [] };
    const cues = captionsOf(
      await plan("s03.sh01", "social_portrait", table, [
        BURN,
        FULL,
        {
          op: "insert",
          entity: "b01",
          path: "/lines",
          value: { id: "b01.l03", text: "Then it moves.", speaker: "narrator" },
        },
        {
          op: "set",
          entity: "s03_the_problem",
          path: "/lines",
          value: ["b01.l01", "b01.l02", "b01.l03"],
        },
      ]),
    )?.props.cues as { start: number; end: number }[];
    expect(cues.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 55],
    ]);
  });

  it("holds a cue for the minimum display time when nothing follows it", async () => {
    const table = timing();
    table.lines["b01.l01"] = {
      ...(table.lines["b01.l01"] as TimingTable["lines"][string]),
      end: 20,
    };
    const cues = captionsOf(await plan("s03.sh01", "social_portrait", table))?.props.cues as {
      start: number;
      end: number;
    }[];
    expect(cues[0]).toMatchObject({ start: 0, end: 30 });
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
