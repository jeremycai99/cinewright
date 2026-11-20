import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_START_TIMEOUT_MS,
  containerCommand,
  resolveContainerImage,
} from "../src/container.js";
import { createSubprocessPlugin } from "../src/host.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import type { PluginManifest } from "../src/manifest.js";
import { validateManifest } from "../src/manifest.js";
import { StderrTail } from "../src/stderr.js";

const STUB_DIR = fileURLToPath(
  new URL("../../sdk-py/tests/fixtures/stub_plugin/", import.meta.url),
);

function containerManifest(secrets: string[] = []): PluginManifest {
  const m = JSON.parse(readFileSync(`${STUB_DIR}manifest.json`, "utf8")) as PluginManifest;
  m.secrets = secrets;
  m.runtime = {
    kind: "subprocess",
    command: ["python", "plugin.py"],
    container: { image: "audio" },
  };
  return m;
}

describe("manifest runtime.container", () => {
  it("validates a containerized subprocess runtime", () => {
    expect(validateManifest(containerManifest()).ok).toBe(true);
  });

  it("rejects an image that is not a logical image name", () => {
    const m = containerManifest() as unknown as { runtime: { container: { image: string } } };
    m.runtime.container.image = "ghcr.io/x/y:latest";
    expect(validateManifest(m).ok).toBe(false);
  });
});

describe("containerCommand", () => {
  const args = containerCommand(
    containerManifest(["SOME_API_KEY"]),
    "/tmp/work dir",
    DEFAULT_LIMITS,
    "cw-p-1",
    {
      image: "cinewright-audio:test",
      pluginDir: "/repo/plugins/stub",
      sdkDir: "/repo/plugins/sdk-py/src",
      user: { uid: 501, gid: 20 },
    },
  );
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  const values = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  it("is an interactive, init-managed, named run with the network off", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("-i");
    expect(args).toContain("--init");
    expect(after("--name")).toBe("cw-p-1");
    expect(after("--network")).toBe("none");
    expect(after("--platform")).toBe("linux/amd64");
    expect(after("--user")).toBe("501:20");
  });

  it("sets every run limit", () => {
    expect(after("--memory")).toBe(`${DEFAULT_LIMITS.memoryMb}m`);
    expect(after("--pids-limit")).toBe(String(DEFAULT_LIMITS.pids));
    expect(after("--cap-drop")).toBe("ALL");
    expect(after("--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--read-only");
  });

  it("mounts the work folder read-write and the plugin and SDK read-only", () => {
    const mounts = values("--mount");
    expect(mounts).toContain('type=bind,"source=/tmp/work dir",target=/work');
    expect(mounts).toContain(
      'type=bind,"source=/repo/plugins/stub",target=/plugins/stub_py,readonly',
    );
    expect(mounts).toContain(
      'type=bind,"source=/repo/plugins/sdk-py/src",target=/opt/cinewright/sdk-py,readonly',
    );
    expect(after("--workdir")).toBe("/plugins/stub_py");
  });

  it("sets the offline environment and passes secrets by name only", () => {
    const env = values("--env");
    for (const e of [
      "HOME=/tmp",
      "HF_HUB_OFFLINE=1",
      "TRANSFORMERS_OFFLINE=1",
      "HF_HOME=/opt/models/hf",
      "PYTHONPATH=/opt/cinewright/sdk-py",
      "CINEWRIGHT_WORK_DIR=/work",
    ]) {
      expect(env).toContain(e);
    }
    expect(env).toContain("SOME_API_KEY");
    expect(env.some((e) => e?.startsWith("SOME_API_KEY="))).toBe(false);
  });

  it("runs the manifest command in the image", () => {
    expect(args.slice(-3)).toEqual(["cinewright-audio:test", "python", "plugin.py"]);
    expect(after("--entrypoint")).toBe("");
  });

  it("gives container plugins a 60 s start timeout", () => {
    expect(CONTAINER_START_TIMEOUT_MS).toBe(60_000);
  });
});

describe("resolveContainerImage", () => {
  const repo = mkdtempSync(join(tmpdir(), "cw-image-"));
  const lock = (digest: string | null) => {
    execFileSync("mkdir", ["-p", join(repo, "container/audio")]);
    writeFileSync(
      join(repo, "container/audio/image.lock.json"),
      JSON.stringify({ image: "ghcr.io/o/cinewright-audio", digest, inputs_hash: digest && "h" }),
    );
  };

  it("prefers CINEWRIGHT_<NAME>_IMAGE", () => {
    lock("sha256:abc");
    expect(
      resolveContainerImage("audio", { env: { CINEWRIGHT_AUDIO_IMAGE: "dev:1" }, repoRoot: repo }),
    ).toBe("dev:1");
  });

  it("uses the locked digest", () => {
    lock("sha256:abc");
    expect(resolveContainerImage("audio", { env: {}, repoRoot: repo })).toBe(
      "ghcr.io/o/cinewright-audio@sha256:abc",
    );
  });

  it("names the fix when the image is unpublished", () => {
    lock(null);
    expect(() => resolveContainerImage("audio", { env: {}, repoRoot: repo })).toThrow(
      /unpublished.*CINEWRIGHT_AUDIO_IMAGE/,
    );
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("StderrTail (F18)", () => {
  it("keeps the last 64 KiB and replaces declared secret values", () => {
    const tail = new StderrTail({ API_KEY: "sk-very-secret" }, 64 * 1024);
    tail.push(`${"x".repeat(70 * 1024)}\n`);
    tail.push("error: bad key sk-very-secret\n");
    const text = tail.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text.endsWith("error: bad key [secret:API_KEY]\n")).toBe(true);
    expect(text).not.toContain("sk-very-secret");
  });

  it("redacts a secret split across chunks and reports whole lines", () => {
    const lines: string[] = [];
    const tail = new StderrTail({ K: "abcdef" }, 1024, (line) => lines.push(line));
    tail.push("token abc");
    tail.push("def ok\nnext");
    tail.push("\n");
    expect(lines).toEqual(["token [secret:K] ok", "next"]);
    expect(tail.text()).toBe("token [secret:K] ok\nnext\n");
  });
});

// Needs Docker and the audio image (CINEWRIGHT_CONTAINER_TESTS=1, CINEWRIGHT_AUDIO_IMAGE).
const containers = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";

function running(name: string): boolean {
  const out = execFileSync(
    "docker",
    ["ps", "--all", "--filter", `name=${name}`, "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    },
  );
  return out.trim().length > 0;
}

async function stopped(name: string, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!running(name)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !running(name);
}

describe.skipIf(!containers)("container plugins leave no containers (G14)", () => {
  it("passes a call through the container, then shutdown removes it", async () => {
    const plugin = createSubprocessPlugin(containerManifest(), STUB_DIR);
    await plugin.init({ secrets: {}, callTimeoutMs: 30_000 });
    const name = plugin.containerName as string;
    expect(running(name)).toBe(true);
    const r = await plugin.call(
      { id: "1", method: "add", params: { a: 2, b: 3 } },
      new AbortController().signal,
    );
    expect(r).toEqual({ ok: true, result: 5 });
    await plugin.shutdown();
    expect(await stopped(name, 10_000)).toBe(true);
  }, 120_000);

  it("kills the container when a call times out", async () => {
    const plugin = createSubprocessPlugin(containerManifest(), STUB_DIR);
    await plugin.init({ secrets: {}, callTimeoutMs: 500 });
    const name = plugin.containerName as string;
    const r = await plugin.call({ id: "h", method: "hang" }, new AbortController().signal);
    expect(r).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(await stopped(name, 10_000)).toBe(true);
    await plugin.shutdown();
  }, 120_000);

  it("kills the container when the host process exits", async () => {
    const child = fileURLToPath(new URL("./host-child.mjs", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [child, JSON.stringify(containerManifest()), STUB_DIR, "exit", "name"],
      {
        encoding: "utf8",
        env: { ...process.env },
      },
    );
    const name = out.trim();
    expect(name).toMatch(/^cinewright-plugin-/);
    expect(await stopped(name, 10_000)).toBe(true);
  }, 120_000);
});
