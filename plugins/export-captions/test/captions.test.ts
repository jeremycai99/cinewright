import { existsSync, readFileSync } from "node:fs";
import { shotSpan, type TimingTable } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { captionCues } from "../../backend-hyperframes/src/captions.js";
import { reference, timing } from "../../backend-hyperframes/test/helpers.js";
import { timelineCues } from "../src/cues.js";
import { CaptionError, cueMs, toSrt, toVtt } from "../src/format.js";
import { exportCaptions } from "../src/plugin.js";

const LANDSCAPE = { max_chars_per_line: 42, max_lines: 2, min_display_frames: 30 };
const PORTRAIT = { max_chars_per_line: 32, max_lines: 2, min_display_frames: 30 };
const solved = (table: TimingTable, start = 0) => ({
  table,
  sequences: { seq_main: { start, frames: 300 } },
});
const SHOTS = ["s03.sh01", "s03.sh02"];

describe("timelineCues (M5.2)", () => {
  it("equals the burn-in's cues, shifted back to the timeline and joined across cuts (Review Focus 4)", async () => {
    const ir = (await reference()).ir();
    const table = timing();
    const drawn = SHOTS.flatMap((shot) => {
      const span = shotSpan(ir, shot, table);
      return captionCues(ir, table, span, "seq_main", LANDSCAPE).map((c) => ({
        text: c.text,
        start: c.start + span.start,
        end: c.end + span.start,
      }));
    });
    const joined: { text: string; start: number; end: number }[] = [];
    for (const cue of drawn) {
      const last = joined.at(-1);
      if (last && last.text === cue.text && last.end === cue.start) last.end = cue.end;
      else joined.push({ ...cue });
    }
    const sidecar = timelineCues(ir, solved(table), LANDSCAPE).map(({ text, start, end }) => ({
      text,
      start,
      end,
    }));
    expect(sidecar.length).toBeGreaterThan(0);
    expect(joined).toEqual(sidecar.filter((c) => c.end > shotSpan(ir, "s03.sh01", table).start));
  });

  it("offsets a sequence's cues by its solved start", async () => {
    const ir = (await reference()).ir();
    const at0 = timelineCues(ir, solved(timing()), LANDSCAPE);
    const at100 = timelineCues(ir, solved(timing(), 100), LANDSCAPE);
    expect(at100.map((c) => c.start)).toEqual(at0.map((c) => c.start + 100));
  });

  it("follows each deliverable's rules: the portrait line limit splits a line the landscape one fits", async () => {
    // 73 characters: two landscape lines of 42 hold it; two portrait lines of 32 do not.
    const text = "Every growing team eventually hits the same wall when its builds slow down";
    const ir = (
      await reference([{ op: "set", entity: "b01.l01", path: "/text", value: text }])
    ).ir();
    const table = timing();
    const words = text.split(" ").map((_, i) => ({ start: 15 + i * 4, end: 15 + i * 4 + 3 }));
    (table.lines["b01.l01"] as { words: unknown[] }).words = words;
    const landscape = timelineCues(ir, solved(table), LANDSCAPE).filter(
      (c) => c.line === "b01.l01",
    );
    const portrait = timelineCues(ir, solved(table), PORTRAIT).filter((c) => c.line === "b01.l01");
    expect(landscape).toHaveLength(1);
    expect(portrait.length).toBeGreaterThan(1);
  });
});

const cues = [
  { line: "b01.l01", text: "Every team hits the same wall.", start: 15, end: 75 },
  { line: "b01.l02", text: "Fish & <chips>", start: 90, end: 150 },
];
const FPS = { num: 30, den: 1 };

describe("SRT and WebVTT", () => {
  it("writes SubRip with counters from 1, comma decimals and blank lines", () => {
    expect(toSrt(cues, FPS)).toBe(
      "1\n00:00:00,500 --> 00:00:02,500\nEvery team hits the same wall.\n\n2\n00:00:03,000 --> 00:00:05,000\nFish & <chips>\n",
    );
  });

  it("writes WebVTT with its header, dot decimals and escaped text", () => {
    expect(toVtt(cues, FPS)).toBe(
      "WEBVTT\n\n00:00:00.500 --> 00:00:02.500\nEvery team hits the same wall.\n\n00:00:03.000 --> 00:00:05.000\nFish &amp; &lt;chips&gt;\n",
    );
    expect(toVtt([], FPS)).toBe("WEBVTT\n");
    expect(toSrt([], FPS)).toBe("");
  });

  it("refuses a cue containing -->, naming the line", () => {
    const bad = [{ line: "b02.l01", text: "a --> b", start: 0, end: 30 }];
    expect(() => toVtt(bad, FPS)).toThrow(CaptionError);
    expect(() => toSrt(bad, FPS)).toThrow(/line b02.l01/);
  });

  it("never overlaps cues or ends one before it starts at 30000/1001 fps", () => {
    const ntsc = { num: 30000, den: 1001 };
    const many = Array.from({ length: 200 }, (_, i) => ({
      line: "l",
      text: `c${i}`,
      start: i * 7,
      end: i * 7 + 7,
    }));
    const ms = cueMs(many, ntsc);
    ms.forEach((c, i) => {
      expect(c.end).toBeGreaterThan(c.start);
      if (ms[i + 1]) expect(c.end).toBeLessThanOrEqual((ms[i + 1] as { start: number }).start);
    });
  });
});

describe("exportCaptions", () => {
  it("always writes both files, burn-in or not, and an unchanged project is a hit", async () => {
    const store = await reference();
    const a = exportCaptions(store.dir, store.ir(), "web_landscape", solved(timing()));
    expect(a.hit).toBe(false);
    expect(a.language).toBe("en");
    expect(a.files.srt).toMatch(/web_landscape\.en\.srt$/);
    expect(readFileSync(a.files.vtt, "utf8").startsWith("WEBVTT\n\n")).toBe(true);
    expect(readFileSync(a.files.srt, "utf8")).toMatch(/^1\n00:00:00,500 --> /);
    expect(exportCaptions(store.dir, store.ir(), "web_landscape", solved(timing())).hit).toBe(true);
    const portrait = exportCaptions(store.dir, store.ir(), "social_portrait", solved(timing()));
    expect(portrait.key).not.toBe(a.key);
    expect(existsSync(portrait.files.srt)).toBe(true);
  });

  it("breaks each cue into the profile's lines, as the burn-in draws it (the tier B measured run)", async () => {
    // 70 characters: one cue (it fits two landscape lines of 42), written as two lines, so the
    // caption critic's line rule passes on the sidecar.
    const text = "Every Saturday morning, there's a free community bike repair workshop.";
    const store = await reference([{ op: "set", entity: "b01.l01", path: "/text", value: text }]);
    const r = exportCaptions(store.dir, store.ir(), "web_landscape", solved(timing()));
    for (const file of [r.files.srt, r.files.vtt]) {
      const body = readFileSync(file, "utf8");
      expect(body).toContain(
        "Every Saturday morning, there's a free\ncommunity bike repair workshop.",
      );
      expect(Math.max(...body.split("\n").map((l) => [...l].length))).toBeLessThanOrEqual(42);
    }
  });

  it("writes valid empty files when nothing is spoken", async () => {
    const store = await reference();
    const r = exportCaptions(
      store.dir,
      store.ir(),
      "web_landscape",
      solved({ fps: FPS, lines: {} }),
    );
    expect(r.cues).toBe(0);
    expect(readFileSync(r.files.vtt, "utf8")).toBe("WEBVTT\n");
    expect(readFileSync(r.files.srt, "utf8")).toBe("");
  });
});
