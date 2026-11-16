import type { InlinedIr } from "../ir/inlined.js";
import { loadPack, type Pack, PackError } from "./load.js";

function fail(pack: string, rule: string, message: string): never {
  throw new PackError([{ pack, file: "", pointer: "", rule, message }]);
}

/**
 * The project's style pack (M3.1a): `style.pack`, found on `searchPath` and checked against its
 * pin in `packs`. Throws PackError: `pack.unset` (no `style.pack`), `pack.unpinned` (no pin for
 * it), `pack.not_found`, or `pack.pin_mismatch` naming the pinned and found versions.
 */
export function resolveProjectPack(ir: InlinedIr, searchPath: readonly string[]): Pack {
  const id = ir.style?.pack?.value;
  if (!id) fail("", "pack.unset", "the project has no style.pack");
  const pin = ir.packs?.[id];
  if (!pin) fail(id, "pack.unpinned", `pack ${id} has no pin; run \`cinewright pack pin ${id}\``);
  const pack = loadPack(id, searchPath);
  if (pack.contentHash !== pin.hash) {
    fail(
      id,
      "pack.pin_mismatch",
      `pinned ${pin.version} (${pin.hash}), found ${pack.version} (${pack.contentHash}); ` +
        `run \`cinewright pack pin ${id}\` to accept the pack on disk`,
    );
  }
  return pack;
}
