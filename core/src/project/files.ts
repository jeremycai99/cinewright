import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { toStoredForm } from "../canonical/stored.js";
import type { Project, Sequence } from "../generated/ir.js";
import { type InlinedIr, inlineIr, splitIr } from "../ir/inlined.js";
import { writeFileAtomic } from "./fsutil.js";
import { PROJECT_FILE, SEQUENCES_DIR, sequenceFile } from "./layout.js";

/** A project file that is missing or cannot be parsed. */
export class ProjectFilesError extends Error {
  override name = "ProjectFilesError";
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

/** The stored form of every IR file: `cinewright.json` and `sequences/<id>.json` (D40). */
export function projectFileContents(ir: InlinedIr): Map<string, string> {
  const { project, sequences } = splitIr(ir);
  const files = new Map<string, string>([[PROJECT_FILE, toStoredForm(project)]]);
  for (const sequence of sequences) files.set(sequenceFile(sequence.id), toStoredForm(sequence));
  return files;
}

async function readJson(dir: string, file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch {
    throw new ProjectFilesError(file, "missing");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProjectFilesError(file, `not valid JSON (${(error as Error).message})`);
  }
}

/** Read the project file and every listed sequence into the inlined IR. */
export async function readProjectFiles(dir: string): Promise<InlinedIr> {
  const project = (await readJson(dir, PROJECT_FILE)) as Project;
  const ids = Array.isArray(project?.sequences?.value) ? project.sequences.value : [];
  const sequences = new Map<string, Sequence>();
  for (const id of ids) sequences.set(id, (await readJson(dir, sequenceFile(id))) as Sequence);
  return inlineIr(project, sequences);
}

/** Sequence files on disk, as relative paths. */
export async function sequenceFilesOnDisk(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, SEQUENCES_DIR)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${SEQUENCES_DIR}/${name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write the IR's files, touching only files whose content changes, and remove sequence files
 * that are no longer listed. Returns the written paths, then the removed ones prefixed with `-`.
 */
export async function writeProjectFiles(dir: string, ir: InlinedIr): Promise<string[]> {
  const contents = projectFileContents(ir);
  const written: string[] = [];
  for (const [file, text] of [...contents].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const current = await readFile(join(dir, file), "utf8").catch(() => null);
    if (current === text) continue;
    await writeFileAtomic(join(dir, file), text);
    written.push(file);
  }
  const removed: string[] = [];
  for (const file of await sequenceFilesOnDisk(dir)) {
    if (contents.has(file)) continue;
    await rm(join(dir, file));
    removed.push(`-${file}`);
  }
  return [...written, ...removed];
}
