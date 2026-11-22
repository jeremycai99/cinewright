import { readFileSync } from "node:fs";
import { type FoundPlugin, findPlugins, doctor as runDoctor } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { pluginPath } from "./narrate.js";

export const DOCTOR_USAGE =
  "usage: cinewright doctor [--image <ref>] [--plugins <dir>]... [--json]";

const REPO = new URL("../../../", import.meta.url);
const KINDS = [
  "llm",
  "tts",
  "stt",
  "music",
  "sfx",
  "image",
  "video",
  "lipsync",
  "stock",
  "backend",
  "critic",
  "exporter",
] as const;

/** `<image>@<digest>` from an image lock, or a note that it is unpublished. */
function locked(path: string): string {
  try {
    const lock = JSON.parse(readFileSync(new URL(path, REPO), "utf8")) as {
      image?: string;
      digest?: string | null;
    };
    if (lock.image && lock.digest) return `${lock.image}@${lock.digest}`;
    return `(unpublished: ${path} has no digest)`;
  } catch {
    return `(no image lock at ${path})`;
  }
}

function wantedNode(): string {
  try {
    return readFileSync(new URL(".node-version", REPO), "utf8").trim();
  } catch {
    return process.versions.node;
  }
}

/**
 * `cinewright doctor` (M8.5): what this machine has for Cinewright. Exit 0 when a keyless Manual
 * render can work (Docker, both locked images, Node), 3 otherwise, naming what is missing and how
 * to fix it. Missing keys and an unreachable CAS remote are named but do not fail it.
 */
export async function doctor(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    image: { type: "string" },
    plugins: { type: "string", multiple: true },
    json: { type: "boolean" },
  });
  const search = pluginPath(io, values.plugins);
  const plugins: FoundPlugin[] = [];
  for (const kind of KINDS) plugins.push(...(await findPlugins(kind, search)));
  const report = await runDoctor({
    images: [
      {
        name: "render",
        ref: values.image ?? io.env.CINEWRIGHT_IMAGE ?? locked("container/image.lock.json"),
      },
      {
        name: "audio",
        ref: io.env.CINEWRIGHT_AUDIO_IMAGE ?? locked("container/audio/image.lock.json"),
      },
    ],
    node: { found: process.versions.node, wanted: wantedNode() },
    plugins,
    env: io.env,
    ...(io.env.CINEWRIGHT_CAS_REMOTE ? { remote: io.env.CINEWRIGHT_CAS_REMOTE } : {}),
  });
  if (values.json) printJson(io, report);
  else {
    const lines: string[] = [];
    for (const c of report.checks) {
      const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn";
      lines.push(`${mark} ${c.id}: ${c.detail}`);
      if (!c.ok && c.fix) lines.push(`     fix: ${c.fix}`);
    }
    lines.push(
      report.ok
        ? "ready: a keyless Manual render can run here"
        : "not ready: fix the FAIL lines above",
    );
    io.stdout(`${lines.join("\n")}\n`);
  }
  return report.ok ? EXIT.ok : EXIT.invalid;
}
