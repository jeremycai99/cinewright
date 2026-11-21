import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { MediaContext } from "./context.js";
import type { Probe } from "./probe.js";
import type { Settings } from "./settings.js";

export interface SpecProfile {
  width: number;
  height: number;
  frame_rate: { num: number; den: number };
  sample_rate: number;
  max_duration?: number;
  encoding?: { codec: string; pix_fmt: string; audio_codec: string };
}

const same = (a: { num: number; den: number }, b: { num: number; den: number }) =>
  a.num * b.den === b.num * a.den;

/**
 * `spec.ffprobe` (M6.1b): the delivered file against its profile and the solved timeline, one
 * finding per field that differs (container, codecs, pixel format, size, frame rate, frame count,
 * audio presence, sample rate, channels, audio within `sync_encoder_frames` encoder frames of the
 * video, and `max_duration` when the profile sets it). Sorted by field.
 */
export function specFindings(
  probe: Probe,
  profile: SpecProfile,
  solved: { frames: number },
  settings: Settings,
  ctx: MediaContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  const s = settings.spec;
  const bad = (field: string, message: string, evidence: CriticFinding["evidence"]) =>
    out.push(
      sign(finding("spec.ffprobe", "error", ctx.deliverable, message, {}, `/${field}`), {
        critic: ctx.critic,
        deliverable: ctx.deliverable,
        evidence,
        key: field,
      }),
    );
  const expect = (field: string, got: string | number, want: string | number) => {
    if (got === want) return;
    const evidence =
      typeof got === "number" && typeof want === "number"
        ? { measured: got, limit: want }
        : { text: `${got} (want ${want})` };
    bad(field, `${field} is ${got}, not ${want}`, evidence);
  };

  expect("container", probe.container, s.container);
  const v = probe.video;
  if (!v) bad("video", "the file has no video stream", {});
  else {
    if (profile.encoding) {
      expect("video_codec", v.codec, s.codecs[profile.encoding.codec] ?? profile.encoding.codec);
      expect("pix_fmt", v.pix_fmt, profile.encoding.pix_fmt);
    }
    expect("width", v.width, profile.width);
    expect("height", v.height, profile.height);
    if (!same(v.frame_rate, profile.frame_rate))
      bad("frame_rate", `frame rate is ${v.frame_rate.num}/${v.frame_rate.den}`, {
        text: `${v.frame_rate.num}/${v.frame_rate.den} (want ${profile.frame_rate.num}/${profile.frame_rate.den})`,
      });
    expect("frames", v.frames, solved.frames);
    if (profile.max_duration !== undefined && v.frames > profile.max_duration)
      bad(
        "max_duration",
        `${v.frames} frames is longer than the profile's ${profile.max_duration}`,
        {
          measured: v.frames,
          limit: profile.max_duration,
        },
      );
  }
  const a = probe.audio;
  if (!a) bad("audio", "the file has no audio stream", {});
  else {
    if (profile.encoding)
      expect(
        "audio_codec",
        a.codec,
        s.codecs[profile.encoding.audio_codec] ?? profile.encoding.audio_codec,
      );
    expect("sample_rate", a.sample_rate, profile.sample_rate);
    expect("channels", a.channels, s.channels);
    if (v) {
      const drift = Math.round(Math.abs(a.duration - v.duration) * 1000) / 1000;
      const limit = (s.sync_encoder_frames * s.aac_frame_samples) / profile.sample_rate;
      if (drift > limit)
        bad("sync", `audio and video end ${drift} s apart`, {
          measured: drift,
          limit: Math.round(limit * 1000) / 1000,
        });
    }
  }
  return out.sort((x, y) => (x.pointer ?? "").localeCompare(y.pointer ?? ""));
}
