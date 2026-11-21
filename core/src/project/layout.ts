/** The on-disk layout of a project (D40, M1.7). Paths are relative to the project directory. */
export const PROJECT_FILE = "cinewright.json";
export const SEQUENCES_DIR = "sequences";
export const LOG_DIR = "log";
export const PATCH_LOG = "log/patches.jsonl";
export const DECISION_LOG = "log/decisions.jsonl";
/** Caches and transient state, ignored by git; never production state (D37). */
export const CACHE_DIR = ".cinewright";
export const CAS_DIR = ".cinewright/cas";
export const RUNS_DIR = ".cinewright/runs";

/** A workflow run's disposable state: its ledger, event log and gate packets (M7.1a). */
export function runDir(projectDir: string, runId: string): string {
  return `${projectDir}/${RUNS_DIR}/${runId}`;
}
export const TXN_DIR = ".cinewright/txn";
/** Disposable shot renders, one folder per render key (M3.2a); deleting it only costs time. */
export const RENDER_CACHE_DIR = ".cinewright/cache/renders";
/** Mixes by mix key (M4.4): disposable, like renders (D37). */
export const MIX_CACHE_DIR = ".cinewright/cache/mixes";
/** Transition segments by segment key (M3.3). */
export const SEGMENT_CACHE_DIR = ".cinewright/cache/segments";
/** Assembled deliverables by assembly key (M5.1). */
export const ASSEMBLY_CACHE_DIR = ".cinewright/cache/assemblies";
/** Caption sidecars by captions key (M5.2). */
export const CAPTIONS_CACHE_DIR = ".cinewright/cache/captions";
/** Compiled compositions, one folder per shot and deliverable, rewritten on each compile. */
export const COMPILED_DIR = ".cinewright/compiled";
export const GITIGNORE = ".cinewright/\n";

const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** True for a valid entity id (convention 9). Only such ids ever become file names. */
export function isEntityId(id: string): boolean {
  return id.length <= 64 && ID.test(id);
}

/** `sequences/<id>.json`; throws for anything that is not a valid id, so no path can escape. */
export function sequenceFile(id: string): string {
  if (!isEntityId(id)) throw new Error(`not a valid sequence id: ${JSON.stringify(id)}`);
  return `${SEQUENCES_DIR}/${id}.json`;
}
