import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { InlinedIr } from "../ir/inlined.js";

/** A hash in the IR's format: `sha256:<64 lowercase hex>`. */
export type HashString = `sha256:${string}`;

/**
 * The hash form (M1 convention 1): RFC 8785 (JCS) canonical JSON, no whitespace. Throws on
 * values JSON cannot represent exactly (NaN, Infinity, lone surrogates) and on `undefined`.
 */
export function toHashForm(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("value has no JSON representation");
  return text;
}

/** SHA-256 over the hash form of `value`. */
export function sha256Hash(value: unknown): HashString {
  return `sha256:${createHash("sha256").update(toHashForm(value), "utf8").digest("hex")}`;
}

/** SHA-256 over raw bytes (asset hashes). */
export function sha256Bytes(bytes: Uint8Array): HashString {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** `state_hash` (M1 convention 11): the hash of the whole inlined IR. No store metadata lives in it. */
export function stateHash(ir: InlinedIr): HashString {
  return sha256Hash(ir);
}
