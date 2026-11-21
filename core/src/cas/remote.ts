import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HashString } from "../canonical/hash.js";

/**
 * A read-only remote for CAS objects (alpha gate A.1): tier A fixtures fetch their frozen
 * assets from one. `fetch` returns the bytes, `null` when the remote does not have the object,
 * or throws. It never receives a credential.
 */
export interface CasRemote {
  name: string;
  fetch(hash: HashString, maxBytes: number): Promise<Uint8Array | null>;
}

export class CasRemoteError extends Error {
  override name = "CasRemoteError";
  constructor(
    readonly rule:
      | "cas.remote_config"
      | "cas.remote_corrupt"
      | "cas.remote_oversized"
      | "cas.remote_failed",
    message: string,
  ) {
    super(message);
  }
}

const hexOf = (hash: string) => hash.replace(/^sha256:/, "");

/**
 * A remote from a URL template with `{hex}` (the object's sha256): `https:` or `file:` only.
 * HTTPS follows redirects only to `https:`, sends no header from the environment, and aborts a
 * body larger than `maxBytes`. A 404 (or a missing file) is `null`.
 */
export function httpRemote(template: string): CasRemote {
  if (!template.includes("{hex}")) {
    throw new CasRemoteError(
      "cas.remote_config",
      `CAS remote ${template} has no {hex} placeholder`,
    );
  }
  const scheme = template.slice(0, template.indexOf(":") + 1);
  if (scheme !== "https:" && scheme !== "file:") {
    throw new CasRemoteError(
      "cas.remote_config",
      `CAS remote ${template}: only https: and file: are allowed`,
    );
  }
  const url = (hash: string) => template.replaceAll("{hex}", hexOf(hash));
  if (scheme === "file:") {
    return {
      name: template,
      async fetch(hash, maxBytes) {
        const path = fileURLToPath(url(hash));
        const info = await stat(path).catch(() => null);
        if (!info) return null;
        if (info.size > maxBytes) {
          throw new CasRemoteError(
            "cas.remote_oversized",
            `${template}: ${hash} is ${info.size} bytes, over ${maxBytes}`,
          );
        }
        return new Uint8Array(await readFile(path));
      },
    };
  }
  return {
    name: template,
    async fetch(hash, maxBytes) {
      let target = url(hash);
      for (let hop = 0; hop < 5; hop += 1) {
        const res = await fetch(target, { redirect: "manual" });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          if (!next) break;
          target = new URL(next, target).href;
          if (!target.startsWith("https:")) {
            throw new CasRemoteError(
              "cas.remote_failed",
              `${template}: refused a redirect to ${target}`,
            );
          }
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok || !res.body)
          throw new CasRemoteError(
            "cas.remote_failed",
            `${template}: HTTP ${res.status} for ${hash}`,
          );
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new CasRemoteError(
              "cas.remote_oversized",
              `${template}: ${hash} is over ${maxBytes} bytes`,
            );
          }
          chunks.push(value);
        }
        return new Uint8Array(Buffer.concat(chunks));
      }
      throw new CasRemoteError("cas.remote_failed", `${template}: too many redirects for ${hash}`);
    },
  };
}

/** The remotes in `CINEWRIGHT_CAS_REMOTE` (comma-separated templates), in order. */
export function remotesFromEnv(env: Readonly<Record<string, string | undefined>>): CasRemote[] {
  return (env.CINEWRIGHT_CAS_REMOTE ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map(httpRemote);
}
