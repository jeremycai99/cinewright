import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import { loadPack, PackError } from "../../src/pack/load.js";
import { resolveProjectPack } from "../../src/pack/pin.js";
import { initProject } from "../../src/project/init.js";
import { readLog } from "../../src/store/log.js";
import { replayLog, Store } from "../../src/store/store.js";
import { OPTIONS, PROFILES, patch, tempDir, USER } from "./helpers.js";

const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));

/** A copy of the repository packs that a test may edit. */
function packCopy(): string {
  const root = tempDir();
  for (const id of ["neutral", "playful"]) {
    cpSync(join(PACKS, id), join(root, id), {
      recursive: true,
      filter: (src) => !/ \d+(\.[a-z]+)?$/.test(src),
    });
  }
  return root;
}

async function pinnedProject(packId: string, packs: string) {
  const dir = tempDir();
  await initProject(
    dir,
    {
      id: "demo",
      deliverables: [{ id: "web", profilePath: join(PROFILES, "landscape_1080p30.json") }],
      pack: loadPack(packId, [packs]),
    },
    OPTIONS,
  );
  return { dir, store: await Store.open(dir, OPTIONS) };
}

function packIssue(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PackError);
    return (error as PackError).errors[0];
  }
  throw new Error("expected a PackError");
}

describe("pack pins (M3.1a)", () => {
  it("init pins the chosen pack and sets style.pack", async () => {
    const packs = packCopy();
    const { store } = await pinnedProject("playful", packs);
    const pack = loadPack("playful", [packs]);
    expect(store.ir().packs).toEqual({
      playful: { version: pack.version, hash: pack.contentHash },
    });
    expect(store.ir().style.pack).toEqual({ state: "user", value: "playful" });
    expect(resolveProjectPack(store.ir(), [packs]).id).toBe("playful");
  });

  it("the pin ignores files that are not part of the pack, such as its README", async () => {
    const packs = packCopy();
    const { store } = await pinnedProject("neutral", packs);
    writeFileSync(join(packs, "neutral", "README.md"), "edited\n");
    writeFileSync(join(packs, "neutral", "notes.txt"), "stray\n");
    expect(resolveProjectPack(store.ir(), [packs]).id).toBe("neutral");
  });

  it("fails with pack.pin_mismatch, naming both versions, after a token edit", async () => {
    const packs = packCopy();
    const { store } = await pinnedProject("neutral", packs);
    const file = join(packs, "neutral", "tokens.json");
    const tokens = JSON.parse(readFileSync(file, "utf8"));
    tokens.palette.accent = "#123456";
    writeFileSync(file, JSON.stringify(tokens));
    const manifestFile = join(packs, "neutral", "pack.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.version = "1.0.1";
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const issue = packIssue(() => resolveProjectPack(store.ir(), [packs]));
    expect(issue?.rule).toBe("pack.pin_mismatch");
    expect(issue?.message).toContain("pinned 1.1.0");
    expect(issue?.message).toContain("found 1.0.1");
    expect(issue?.message).toContain("cinewright pack pin neutral");
  });

  it("pinPack recovers, and replaying the log reproduces the pin", async () => {
    const packs = packCopy();
    const { dir, store } = await pinnedProject("neutral", packs);
    const file = join(packs, "neutral", "tokens.json");
    const tokens = JSON.parse(readFileSync(file, "utf8"));
    tokens.palette.accent = "#123456";
    writeFileSync(file, JSON.stringify(tokens));
    const result = await store.pinPack(loadPack("neutral", [packs]), USER);
    expect(result).toMatchObject({ status: "applied", revision: 1 });
    expect(resolveProjectPack(store.ir(), [packs]).id).toBe("neutral");
    const log = await readLog(dir);
    expect(log.at(-1)).toMatchObject({ kind: "pinned", pack: "neutral", revision: 1 });
    expect(stateHash(replayLog(log))).toBe(stateHash(store.ir()));
    const reopened = await Store.open(dir, OPTIONS);
    expect(reopened.ir().packs).toEqual(store.ir().packs);
  });

  it("pins on top of a patch another process applied since this store opened", async () => {
    const packs = packCopy();
    const { dir, store } = await pinnedProject("neutral", packs);
    const other = await Store.open(dir, OPTIONS);
    const applied = await other.apply(
      patch(other, [{ op: "set", entity: "demo", path: "/brief", value: "From elsewhere." }]),
    );
    expect(applied).toMatchObject({ status: "applied", revision: 1 });
    const result = await store.pinPack(loadPack("neutral", [packs]), USER);
    expect(result).toMatchObject({ status: "applied", revision: 2 });
    const reopened = await Store.open(dir, OPTIONS);
    expect(reopened.revision()).toBe(2);
    expect(reopened.ir().brief).toEqual({ state: "user", value: "From elsewhere." });
  });

  it("is pack.unpinned when style.pack names a pack with no pin", async () => {
    const packs = packCopy();
    const { store } = await pinnedProject("neutral", packs);
    const applied = await store.apply(
      patch(store, [{ op: "set", entity: "demo", path: "/style/pack", value: "playful" }]),
    );
    expect(applied.status).toBe("applied");
    expect(packIssue(() => resolveProjectPack(store.ir(), [packs]))?.rule).toBe("pack.unpinned");
  });

  it("is pack.not_found when the pinned pack is not on the search path", async () => {
    const packs = packCopy();
    const { store } = await pinnedProject("neutral", packs);
    expect(packIssue(() => resolveProjectPack(store.ir(), [tempDir()]))?.rule).toBe(
      "pack.not_found",
    );
  });

  it("a project without a pin has no packs and an open style.pack", async () => {
    const dir = tempDir();
    await initProject(
      dir,
      {
        id: "demo",
        deliverables: [{ id: "web", profilePath: join(PROFILES, "landscape_1080p30.json") }],
      },
      OPTIONS,
    );
    const store = await Store.open(dir, OPTIONS);
    expect(store.ir().packs).toBeUndefined();
    expect(packIssue(() => resolveProjectPack(store.ir(), [packCopy()]))?.rule).toBe("pack.unset");
  });
});
