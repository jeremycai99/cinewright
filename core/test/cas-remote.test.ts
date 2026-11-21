import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../src/canonical/hash.js";
import { Cas, CasMissingError } from "../src/cas/cas.js";
import { type CasRemote, CasRemoteError, httpRemote, remotesFromEnv } from "../src/cas/remote.js";

const bytes = new TextEncoder().encode("frozen take");
const hash = sha256Bytes(bytes);
const hex = hash.slice(7);

function fileRemote(files: Record<string, Uint8Array> = { [hex]: bytes }): {
  template: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cw-remote-"));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  return { template: `${pathToFileURL(dir).href}/{hex}`, dir };
}

function counting(remote: CasRemote) {
  let calls = 0;
  return {
    remote: {
      name: remote.name,
      fetch: (h: never, m: number) => {
        calls++;
        return remote.fetch(h, m);
      },
    } as CasRemote,
    calls: () => calls,
  };
}

const project = () => mkdtempSync(join(tmpdir(), "cw-cas-"));

describe("CAS remotes (A.1)", () => {
  it("serves a local miss from a file: remote, stores it, and needs the remote only once", async () => {
    const { remote, calls } = counting(httpRemote(fileRemote().template));
    const cas = new Cas(project(), { remotes: [remote] });
    expect(new Uint8Array(await cas.get(hash))).toEqual(bytes);
    expect(await cas.has(hash)).toBe(true);
    expect(new Uint8Array(await cas.get(hash))).toEqual(bytes);
    expect(calls()).toBe(1);
  });

  it("refuses bytes that do not hash to the object, storing nothing (Review Focus 1)", async () => {
    const cas = new Cas(project(), {
      remotes: [httpRemote(fileRemote({ [hex]: new TextEncoder().encode("evil") }).template)],
    });
    await expect(cas.get(hash)).rejects.toMatchObject({ rule: "cas.remote_corrupt" });
    expect(await cas.has(hash)).toBe(false);
  });

  it("aborts an object larger than the asset's recorded size (Review Focus 1)", async () => {
    const cas = new Cas(project(), { remotes: [httpRemote(fileRemote().template)] });
    await expect(cas.get(hash, 3)).rejects.toMatchObject({ rule: "cas.remote_oversized" });
    expect(await cas.has(hash)).toBe(false);
  });

  it("falls through a remote that lacks the object, and reports failures only when all fail", async () => {
    const empty = httpRemote(fileRemote({}).template);
    const broken: CasRemote = {
      name: "broken",
      fetch: async () => {
        throw new Error("connection reset");
      },
    };
    const good = httpRemote(fileRemote().template);
    expect(await new Cas(project(), { remotes: [empty, broken, good] }).get(hash)).toEqual(bytes);
    const error = await new Cas(project(), { remotes: [empty, broken] }).get(hash).catch((e) => e);
    expect(error).toBeInstanceOf(CasMissingError);
    expect(error.message).toMatch(/not found.*broken \(connection reset\)/s);
  });

  it("behaves as before with no remote", async () => {
    const error = await new Cas(project(), { remotes: [] }).get(hash).catch((e) => e);
    expect(error).toBeInstanceOf(CasMissingError);
    expect(error.message).toBe(`CAS has no object ${hash}`);
  });

  it("rejects any scheme but https: and file:, naming the template", () => {
    expect(() => httpRemote("http://example.invalid/{hex}")).toThrow(
      /http:\/\/example.invalid\/\{hex\}: only https: and file:/,
    );
    expect(() => httpRemote("https://example.invalid/no-placeholder")).toThrow(CasRemoteError);
    expect(
      remotesFromEnv({
        CINEWRIGHT_CAS_REMOTE: "https://a.invalid/{hex}, https://b.invalid/{hex}",
      }).map((r) => r.name),
    ).toEqual(["https://a.invalid/{hex}", "https://b.invalid/{hex}"]);
    expect(remotesFromEnv({})).toEqual([]);
  });

  it("sends no header from the environment over https", async () => {
    const seen: RequestInit[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    try {
      const got = await httpRemote("https://cas.invalid/{hex}").fetch(hash, 1000);
      expect(got).toEqual(bytes);
      expect(seen[0]?.headers).toBeUndefined();
    } finally {
      globalThis.fetch = real;
    }
  });
});
