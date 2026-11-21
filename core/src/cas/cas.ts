import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type HashString, sha256Bytes } from "../canonical/hash.js";
import type { InlinedIr } from "../ir/inlined.js";
import { writeFileAtomic } from "../project/fsutil.js";
import { CAS_DIR } from "../project/layout.js";
import { type CasRemote, CasRemoteError, remotesFromEnv } from "./remote.js";

const HASH = /^sha256:([0-9a-f]{64})$/;

export class CasMissingError extends Error {
  override name = "CasMissingError";
  constructor(
    readonly hash: string,
    readonly tried: readonly string[] = [],
  ) {
    super(
      `CAS has no object ${hash}${tried.length ? ` (remotes tried: ${tried.join("; ")})` : ""}`,
    );
  }
}

export class CasCorruptError extends Error {
  override name = "CasCorruptError";
  constructor(readonly hash: string) {
    super(`CAS object ${hash} is corrupt: its bytes no longer hash to ${hash}`);
  }
}

export class AssetMissingError extends Error {
  override name = "AssetMissingError";
  constructor(
    readonly assetId: string,
    message: string,
  ) {
    super(message);
  }
}

/** The content-addressed store under `.cinewright/cas/` (M1.7): atomic put, hash verified on get. */
export class Cas {
  readonly root: string;
  readonly remotes: readonly CasRemote[];

  /**
   * `remotes` defaults to `CINEWRIGHT_CAS_REMOTE` (alpha gate A.1), so jobs and plugins that open
   * the CAS fetch frozen assets without each being configured.
   */
  constructor(projectDir: string, options: { remotes?: readonly CasRemote[] } = {}) {
    this.root = join(projectDir, CAS_DIR);
    this.remotes = options.remotes ?? remotesFromEnv(process.env);
  }

  pathOf(hash: string): string {
    const hex = HASH.exec(hash)?.[1];
    if (!hex) throw new Error(`not a sha256 hash: ${hash}`);
    return join(this.root, "sha256", hex.slice(0, 2), hex.slice(2));
  }

  async put(bytes: Uint8Array): Promise<HashString> {
    const hash = sha256Bytes(bytes);
    if (!(await this.has(hash))) await writeFileAtomic(this.pathOf(hash), bytes);
    return hash;
  }

  async has(hash: string): Promise<boolean> {
    return stat(this.pathOf(hash)).then(
      () => true,
      () => false,
    );
  }

  /**
   * The object's bytes, verified. On a local miss each remote is tried in order: bytes that do
   * not hash to `hash` are `cas.remote_corrupt` and nothing is stored; a body over `maxBytes`
   * is `cas.remote_oversized`. A remote's other failure counts only if every remote fails.
   */
  async get(hash: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathOf(hash));
    } catch {
      return this.fetchRemote(hash, maxBytes);
    }
    if (sha256Bytes(bytes) !== hash) throw new CasCorruptError(hash);
    return bytes;
  }

  private async fetchRemote(hash: string, maxBytes: number): Promise<Uint8Array> {
    const tried: string[] = [];
    for (const remote of this.remotes) {
      let bytes: Uint8Array | null;
      try {
        bytes = await remote.fetch(hash as HashString, maxBytes);
      } catch (error) {
        if (error instanceof CasRemoteError && error.rule === "cas.remote_oversized") throw error;
        tried.push(`${remote.name} (${(error as Error).message})`);
        continue;
      }
      if (bytes === null) {
        tried.push(`${remote.name} (not found)`);
        continue;
      }
      if (sha256Bytes(bytes) !== hash) {
        throw new CasRemoteError(
          "cas.remote_corrupt",
          `${remote.name} served bytes that do not hash to ${hash}`,
        );
      }
      await writeFileAtomic(this.pathOf(hash), bytes);
      return bytes;
    }
    throw new CasMissingError(hash, tried);
  }
}

/** The bytes of an asset the IR registers, verified against its hash. */
export async function resolveAsset(ir: InlinedIr, cas: Cas, assetId: string): Promise<Uint8Array> {
  const asset = (ir.assets.value ?? []).find((a) => a.id === assetId);
  if (!asset)
    throw new AssetMissingError(assetId, `asset ${assetId} is not registered in the project`);
  try {
    return await cas.get(asset.hash, asset.bytes);
  } catch (error) {
    if (error instanceof CasMissingError) {
      throw new AssetMissingError(
        assetId,
        `asset ${assetId} (${asset.hash}) is missing from the CAS`,
      );
    }
    throw error;
  }
}
