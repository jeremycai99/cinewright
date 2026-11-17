import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HashString, sha256Hash, stateHash } from "../canonical/hash.js";
import type { Deliverable, DeliveryProfile, ProfileCopy } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";
import type { Pack } from "../pack/load.js";
import type { ValidationError } from "../schema/errors.js";
import { validateDocument, validateProject } from "../schema/validate.js";
import { appendLog, type InitEntry } from "../store/log.js";
import { writeProjectFiles } from "./files.js";
import { CAS_DIR, DECISION_LOG, GITIGNORE, PROJECT_FILE, RUNS_DIR } from "./layout.js";

/** `init` refused: the reason, and validation errors when there are any. */
export class InitError extends Error {
  override name = "InitError";
  constructor(
    message: string,
    readonly errors: ValidationError[] = [],
  ) {
    super(message);
  }
}

export interface InitInput {
  id: string;
  title?: string;
  /** At least one: the frame rate comes from a delivery profile (D27). */
  deliverables: { id: string; profilePath: string }[];
  /** The style pack to pin and select (M3.1a); without one, `style.pack` stays open. */
  pack?: Pack;
}

export interface InitOptions {
  sessionId: string;
  now: () => string;
}

export interface InitResult {
  dir: string;
  revision: 0;
  stateHash: HashString;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

async function readProfile(path: string): Promise<DeliveryProfile> {
  let body: unknown;
  try {
    body = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new InitError(`cannot read delivery profile ${path}: ${(error as Error).message}`);
  }
  const errors = validateDocument("delivery_profile", body);
  if (errors.length > 0) throw new InitError(`invalid delivery profile ${path}`, errors);
  return body as DeliveryProfile;
}

/**
 * Create a project (M1.7): `cinewright.json`, `.gitignore`, `log/` with the `init` entry, and
 * `.cinewright/{cas,runs}`. Each delivery profile is copied into the project with its hash
 * (convention 16); every field the caller does not give is `open`.
 */
export async function initProject(
  dir: string,
  input: InitInput,
  options: InitOptions,
): Promise<InitResult> {
  if (await exists(join(dir, PROJECT_FILE))) {
    throw new InitError(`${dir} already holds a project (${PROJECT_FILE})`);
  }
  if (input.deliverables.length === 0) {
    throw new InitError(
      "a project needs at least one deliverable: its profile sets the frame rate",
    );
  }
  const profiles: Record<string, ProfileCopy> = {};
  const deliverables: Deliverable[] = [];
  for (const { id, profilePath } of input.deliverables) {
    const body = await readProfile(profilePath);
    const copy = { hash: sha256Hash(body), body };
    const existing = profiles[body.id];
    if (existing && existing.hash !== copy.hash) {
      throw new InitError(`two different delivery profiles share the id ${body.id}`);
    }
    profiles[body.id] = copy;
    deliverables.push({
      id,
      origin: "user",
      profile: { value: body.id, state: "user" },
      label: { state: "open" },
      burn_in_captions: { state: "open" },
    });
  }
  const ir: InlinedIr = {
    id: input.id,
    origin: "user",
    schema_version: 1,
    profiles,
    ...(input.pack
      ? {
          packs: { [input.pack.id]: { version: input.pack.version, hash: input.pack.contentHash } },
        }
      : {}),
    title: input.title === undefined ? { state: "open" } : { value: input.title, state: "user" },
    brief: { state: "open" },
    autonomy: { state: "open" },
    budget: { state: "open" },
    policies: { state: "open" },
    settings: { propose_conversational_edits: { value: true, state: "user" } },
    style: {
      pack: input.pack ? { state: "user", value: input.pack.id } : { state: "open" },
      overrides: {},
    },
    deliverables: { value: deliverables, state: "user" },
    sequences: { state: "open" },
    script: { id: "script", origin: "user", beats: { state: "open" } },
    cast: { state: "open" },
    assets: { state: "open" },
  };
  const errors = validateProject(ir);
  if (errors.length > 0) throw new InitError("the new project would not be valid", errors);

  await mkdir(join(dir, CAS_DIR), { recursive: true });
  await mkdir(join(dir, RUNS_DIR), { recursive: true });
  await writeProjectFiles(dir, ir);
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
  await mkdir(join(dir, "log"), { recursive: true });
  await writeFile(join(dir, DECISION_LOG), "");
  const hash = stateHash(ir);
  const entry: InitEntry = {
    seq: 1,
    kind: "init",
    revision: 0,
    time: options.now(),
    session_id: options.sessionId,
    author: { kind: "user" },
    ir: ir as unknown as InitEntry["ir"],
    state_hash: hash,
  };
  await appendLog(dir, entry);
  return { dir, revision: 0, stateHash: hash };
}
