import { basename, dirname } from "node:path";
import { tool } from "./docker.js";

/** What `ffprobe` says about a delivered file (M5.1); M6.1b's spec check reuses it. */
export interface Probe {
  container: string;
  video?: {
    codec: string;
    pix_fmt: string;
    width: number;
    height: number;
    frame_rate: { num: number; den: number };
    frames: number;
    duration: number;
  };
  audio?: { codec: string; sample_rate: number; channels: number; duration: number };
}

interface Stream {
  codec_type: string;
  codec_name: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

export async function probe(file: string, image: string): Promise<Probe> {
  const { stdout } = await tool({
    image,
    entrypoint: "ffprobe",
    inDir: dirname(file),
    args: [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      `/x/in/${basename(file)}`,
    ],
  });
  const doc = JSON.parse(stdout) as { streams: Stream[]; format: { format_name: string } };
  const v = doc.streams.find((s) => s.codec_type === "video");
  const a = doc.streams.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    container: doc.format.format_name,
    ...(v
      ? {
          video: {
            codec: v.codec_name,
            pix_fmt: v.pix_fmt ?? "",
            width: v.width ?? 0,
            height: v.height ?? 0,
            frame_rate: { num: num ?? 0, den: den ?? 1 },
            frames: Number(v.nb_read_frames ?? 0),
            duration: Number(v.duration ?? 0),
          },
        }
      : {}),
    ...(a
      ? {
          audio: {
            codec: a.codec_name,
            sample_rate: Number(a.sample_rate ?? 0),
            channels: a.channels ?? 0,
            duration: Number(a.duration ?? 0),
          },
        }
      : {}),
  };
}
