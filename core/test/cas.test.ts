import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../src/canonical/hash.js";
import {
  AssetMissingError,
  Cas,
  CasCorruptError,
  CasMissingError,
  resolveAsset,
} from "../src/cas/cas.js";
import type { InlinedIr } from "../src/ir/inlined.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-cas-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bytes = new TextEncoder().encode("frame data");

describe("Cas", () => {
  it("puts and gets bytes by their SHA-256", async () => {
    const cas = new Cas(tempDir());
    const hash = await cas.put(bytes);
    expect(hash).toBe(sha256Bytes(bytes));
    expect(await cas.has(hash)).toBe(true);
    expect(Buffer.from(await cas.get(hash)).toString()).toBe("frame data");
    expect(await cas.put(bytes)).toBe(hash);
  });

  it("fails on a corrupted file, naming the hash", async () => {
    const dir = tempDir();
    const cas = new Cas(dir);
    const hash = await cas.put(bytes);
    const path = cas.pathOf(hash);
    const data = readFileSync(path);
    data[0] = (data[0] ?? 0) ^ 0xff;
    writeFileSync(path, data);
    const error = await cas.get(hash).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CasCorruptError);
    expect((error as Error).message).toContain(hash);
  });

  it("fails on a missing hash, naming it", async () => {
    const cas = new Cas(tempDir());
    const missing = sha256Bytes(new TextEncoder().encode("never stored"));
    const error = await cas.get(missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CasMissingError);
    expect((error as Error).message).toContain(missing);
  });
});

describe("resolveAsset", () => {
  const ir = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/ir/reference.json", import.meta.url)), "utf8"),
  ) as InlinedIr;

  it("resolves an asset referenced by id from the CAS", async () => {
    const cas = new Cas(tempDir());
    await cas.put(new TextEncoder().encode("sheet-front"));
    const data = await resolveAsset(ir, cas, "dr_lin_sheet_front");
    expect(Buffer.from(data).toString()).toBe("sheet-front");
  });

  it("names the referencing entity when the asset's bytes are missing", async () => {
    const error = await resolveAsset(ir, new Cas(tempDir()), "dr_lin_sheet_profile").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AssetMissingError);
    expect((error as Error).message).toContain("dr_lin_sheet_profile");
  });
});
