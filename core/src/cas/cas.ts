import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type HashString, sha256Bytes } from "../canonical/hash.js";
import type { InlinedIr } from "../ir/inlined.js";
import { writeFileAtomic } from "../project/fsutil.js";
import { CAS_DIR } from "../project/layout.js";

const HASH = /^sha256:([0-9a-f]{64})$/;

export class CasMissingError extends Error {
  override name = "CasMissingError";
  constructor(readonly hash: string) {
    super(`CAS has no object ${hash}`);
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

  constructor(projectDir: string) {
    this.root = join(projectDir, CAS_DIR);
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

  async get(hash: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathOf(hash));
    } catch {
      throw new CasMissingError(hash);
    }
    if (sha256Bytes(bytes) !== hash) throw new CasCorruptError(hash);
    return bytes;
  }
}

/** The bytes of an asset the IR registers, verified against its hash. */
export async function resolveAsset(ir: InlinedIr, cas: Cas, assetId: string): Promise<Uint8Array> {
  const asset = (ir.assets.value ?? []).find((a) => a.id === assetId);
  if (!asset)
    throw new AssetMissingError(assetId, `asset ${assetId} is not registered in the project`);
  try {
    return await cas.get(asset.hash);
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
