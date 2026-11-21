import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { ScriptContext } from "./context.js";
import type { Settings } from "./settings.js";

/** A cue as a sidecar states it, in milliseconds. */
export interface SidecarCue {
  start: number;
  end: number;
  text: string;
}

/** A cue the timing implies (`sequenceCues`, offset to the project timeline), in frames. */
export interface ExpectedCue {
  line: string;
  text: string;
  start: number;
  end: number;
}

export interface CaptionRules {
  max_chars_per_line: number;
  max_lines: number;
  min_display_frames: number;
}

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/;

function cueBlocks(text: string): SidecarCue[] {
  const out: SidecarCue[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0) continue;
    const t = (TIME.exec(lines[at] as string) as RegExpExecArray).slice(1).map(Number);
    const ms = (h: number, m: number, s: number, f: number) => ((h * 60 + m) * 60 + s) * 1000 + f;
    out.push({
      start: ms(t[0] as number, t[1] as number, t[2] as number, t[3] as number),
      end: ms(t[4] as number, t[5] as number, t[6] as number, t[7] as number),
      text: lines
        .slice(at + 1)
        .join("\n")
        .trimEnd(),
    });
  }
  return out;
}

/** SubRip cues: counter, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text. */
export function parseSrt(text: string): SidecarCue[] {
  return cueBlocks(text);
}

/** WebVTT cues, with `&amp;`, `&lt;` and `&gt;` unescaped. */
export function parseVtt(text: string): SidecarCue[] {
  return cueBlocks(text.replace(/^WEBVTT[^\n]*\n/, "")).map((c) => ({
    ...c,
    text: c.text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  }));
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The caption timing checks (M6.1c, AGENTS.md §4.2) on what ships: the SRT sidecar's cues, against
 * the cues the timing implies and the profile's caption rules. Each sidecar cue is matched, in
 * order, to the expected cue with the same text.
 * - `captions.overlap`: a cue ends after the next starts.
 * - `captions.out_of_range`: a cue starts before 0 or ends after the film.
 * - `captions.short_display`: shorter than `min_display_frames` although the next cue (or the end)
 *   leaves room to hold it.
 * - `captions.line_too_long`: a caption line over `max_chars_per_line`, or more than `max_lines`.
 * - `captions.missing_line`: a spoken line with no cue in the sidecar.
 * - `captions.sync`: a cue starts more than `captions.sync_frames` from its first word, or the VTT
 *   sidecar disagrees with the SRT.
 */
export function captionFindings(
  sidecars: { srt: readonly SidecarCue[]; vtt: readonly SidecarCue[] },
  expected: readonly ExpectedCue[],
  spoken: readonly string[],
  solved: { frames: number },
  rules: CaptionRules,
  settings: Settings,
  ctx: ScriptContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  const toFrame = (ms: number) => Math.round((ms * ctx.fps.num) / (1000 * ctx.fps.den));
  const toMs = (frames: number) => Math.round((frames * 1000 * ctx.fps.den) / ctx.fps.num);
  const cues = sidecars.srt;
  const matched: (ExpectedCue | undefined)[] = [];
  let next = 0;
  for (const cue of cues) {
    const at = expected.findIndex((e, i) => i >= next && flat(e.text) === flat(cue.text));
    matched.push(at < 0 ? undefined : expected[at]);
    if (at >= 0) next = at + 1;
  }
  const add = (
    rule: string,
    i: number,
    message: string,
    key: string,
    evidence: CriticFinding["evidence"],
  ) => {
    const cue = cues[i] as SidecarCue;
    const start = Math.max(0, toFrame(cue.start));
    out.push(
      sign(finding(rule, "error", matched[i]?.line ?? ctx.deliverable, message, { cue: i + 1 }), {
        critic: ctx.critic,
        deliverable: ctx.deliverable,
        frames: { start, end: Math.max(start + 1, toFrame(cue.end)) },
        evidence: { text: cue.text, ...evidence },
        key,
      }),
    );
  };

  const filmEnd = toMs(solved.frames);
  const minMs = toMs(rules.min_display_frames);
  for (const [i, cue] of cues.entries()) {
    const following = cues[i + 1];
    if (following && cue.end > following.start)
      add("captions.overlap", i, `cue ${i + 1} ends after cue ${i + 2} starts`, "overlap", {
        measured: cue.end - following.start,
      });
    if (cue.start < 0 || cue.end > filmEnd)
      add("captions.out_of_range", i, `cue ${i + 1} runs past the film`, "out_of_range", {
        measured: cue.end,
        limit: filmEnd,
      });
    const room = (following?.start ?? filmEnd) - cue.start;
    if (cue.end - cue.start < minMs && room >= minMs)
      add(
        "captions.short_display",
        i,
        `cue ${i + 1} shows for ${cue.end - cue.start} ms`,
        "short_display",
        {
          measured: cue.end - cue.start,
          limit: minMs,
        },
      );
    const lines = cue.text.split("\n");
    const longest = Math.max(...lines.map((l) => [...l].length));
    if (longest > rules.max_chars_per_line || lines.length > rules.max_lines)
      add(
        "captions.line_too_long",
        i,
        `cue ${i + 1} has a ${longest}-character line`,
        "line_too_long",
        {
          measured: longest,
          limit: rules.max_chars_per_line,
        },
      );
    const want = matched[i];
    if (want && Math.abs(toFrame(cue.start) - want.start) > settings.captions.sync_frames)
      add(
        "captions.sync",
        i,
        `cue ${i + 1} starts ${toFrame(cue.start) - want.start} frames from its first word`,
        "sync",
        {
          measured: toFrame(cue.start) - want.start,
          limit: settings.captions.sync_frames,
        },
      );
    const vtt = sidecars.vtt[i];
    if (!vtt || vtt.start !== cue.start || vtt.end !== cue.end || flat(vtt.text) !== flat(cue.text))
      add("captions.sync", i, `the VTT sidecar's cue ${i + 1} differs from the SRT's`, "vtt", {});
  }

  const shown = new Set(matched.flatMap((m) => (m ? [m.line] : [])));
  for (const line of spoken) {
    if (shown.has(line)) continue;
    out.push(
      sign(
        finding("captions.missing_line", "error", line, `spoken line ${line} has no caption`, {}),
        {
          critic: ctx.critic,
          deliverable: ctx.deliverable,
          evidence: {},
          key: "missing_line",
        },
      ),
    );
  }
  return out;
}
