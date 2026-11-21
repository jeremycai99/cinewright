import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

/** One item of a `library.json` (M4.3a). */
export interface LibraryItem {
  id: string;
  kind: "music" | "sfx";
  /** WAV file, relative to the library folder. */
  file: string;
  sha256: string;
  /** Descriptive words for matching: genres for music, names for SFX. */
  tags: string[];
  mood?: string[];
  bpm?: number;
  duration_ms: number;
  vocals?: boolean;
  /** The bed may be looped to fill a longer sequence. */
  loop?: boolean;
  license: { terms: string; commercial_use: boolean; attribution?: string };
}

export interface LoadedItem extends LibraryItem {
  /** The absolute path of the file. */
  path: string;
}

export class LibraryError extends Error {
  override name = "LibraryError";
}

const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

function check(item: unknown, where: string): LibraryItem {
  const i = item as Partial<LibraryItem> & Record<string, unknown>;
  const id = typeof i.id === "string" ? i.id : "?";
  const fail = (why: string): never => {
    throw new LibraryError(`${where}: item ${id} ${why}`);
  };
  if (typeof i.id !== "string" || !ID.test(i.id)) fail("needs an id like `calm_bed_01`");
  if (i.kind !== "music" && i.kind !== "sfx") fail('needs kind "music" or "sfx"');
  if (typeof i.file !== "string" || !i.file) fail("needs a file");
  if (typeof i.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(i.sha256))
    fail("needs the file's sha256");
  if (!Array.isArray(i.tags) || !i.tags.every((t) => typeof t === "string")) fail("needs tags");
  if (typeof i.duration_ms !== "number" || i.duration_ms <= 0) fail("needs duration_ms");
  const license = i.license as LibraryItem["license"] | undefined;
  if (
    !license ||
    typeof license.terms !== "string" ||
    !license.terms ||
    typeof license.commercial_use !== "boolean"
  ) {
    fail("has no licence (terms and commercial_use are required; AGENTS.md §6)");
  }
  return i as LibraryItem;
}

/**
 * Every item of every `library.json` on the path (folders separated by the platform's path
 * delimiter). An item without a licence, id, file hash or duration is an error naming it.
 */
export function loadLibrary(pathList: string | undefined): LoadedItem[] {
  const out: LoadedItem[] = [];
  const seen = new Set<string>();
  for (const dir of (pathList ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, "library.json");
    if (!existsSync(file)) throw new LibraryError(`no library.json in ${dir}`);
    let doc: { items?: unknown };
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as { items?: unknown };
    } catch (error) {
      throw new LibraryError(`${file}: ${(error as Error).message}`);
    }
    if (!Array.isArray(doc.items)) throw new LibraryError(`${file}: needs an items list`);
    for (const raw of doc.items) {
      const item = check(raw, file);
      if (seen.has(item.id)) throw new LibraryError(`${file}: item ${item.id} appears twice`);
      seen.add(item.id);
      const path = resolve(dir, item.file);
      if (!path.startsWith(resolve(dir) + sep))
        throw new LibraryError(`${file}: item ${item.id}'s file is outside the library`);
      out.push({ ...item, path });
    }
  }
  return out;
}

export function words(text: string | readonly string[]): Set<string> {
  const all = Array.isArray(text) ? text.join(" ") : (text as string);
  return new Set(
    all
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

/**
 * The best music bed for a request, or undefined. Candidates are instrumental, at least as long
 * as the request (or loopable), and inside the BPM range when they state a BPM. Score: genre
 * words shared ×2, mood words shared, brief words shared with tags or mood; ties go to the BPM
 * nearest the middle of the range, then to the id. Deterministic.
 */
export function chooseMusic(
  items: readonly LoadedItem[],
  request: {
    genre: string;
    mood: string;
    brief?: string;
    bpm_min: number;
    bpm_max: number;
    duration_ms: number;
  },
): LoadedItem | undefined {
  const genre = words(request.genre);
  const mood = words(request.mood);
  const brief = words(request.brief ?? "");
  const middle = (request.bpm_min + request.bpm_max) / 2;
  const scored = items
    .filter((i) => i.kind === "music" && i.vocals !== true)
    .filter((i) => i.duration_ms >= request.duration_ms || i.loop === true)
    .filter((i) => i.bpm === undefined || (i.bpm >= request.bpm_min && i.bpm <= request.bpm_max))
    .map((i) => {
      const tags = words(i.tags);
      const moods = words(i.mood ?? []);
      const score =
        2 * overlap(genre, tags) +
        overlap(mood, moods) +
        overlap(brief, new Set([...tags, ...moods]));
      return {
        i,
        score,
        distance: i.bpm === undefined ? Number.POSITIVE_INFINITY : Math.abs(i.bpm - middle),
      };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.distance - b.distance || a.i.id.localeCompare(b.i.id));
  return scored[0]?.i;
}

/** The SFX item whose id or tags name the effect (case-insensitive); ties go to the id. */
export function chooseSfx(items: readonly LoadedItem[], name: string): LoadedItem | undefined {
  const wanted = name.toLowerCase().trim();
  return items
    .filter(
      (i) =>
        i.kind === "sfx" && (i.id === wanted || i.tags.some((t) => t.toLowerCase() === wanted)),
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
