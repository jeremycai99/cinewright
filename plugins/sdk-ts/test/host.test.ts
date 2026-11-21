import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSubprocessPlugin } from "../src/host.js";
import { type GoldenCase, runConformance } from "../src/kit.js";
import type { PluginManifest } from "../src/manifest.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const STUB_DIR = fileURLToPath(
  new URL("../../sdk-py/tests/fixtures/stub_plugin/", import.meta.url),
);
const PYTHON = process.env.CINEWRIGHT_PYTHON ?? `${REPO}.venv/bin/python`;
const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/stub-plugin/golden.json", import.meta.url)),
    "utf8",
  ),
) as GoldenCase[];
const HOST_CHILD = fileURLToPath(new URL("./host-child.mjs", import.meta.url));

/** The Python stub's manifest, with the interpreter that has the SDK installed. */
function manifest(): PluginManifest {
  const m = JSON.parse(readFileSync(`${STUB_DIR}manifest.json`, "utf8")) as PluginManifest;
  m.runtime = { kind: "subprocess", command: [PYTHON, "plugin.py"] };
  return m;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

// CI runs these in the `py` job, where the uv environment exists (CINEWRIGHT_PYTHON_PLUGIN_TESTS=1).
const run = existsSync(PYTHON) || process.env.CINEWRIGHT_PYTHON_PLUGIN_TESTS === "1";

describe.skipIf(!run)("subprocess host with the Python stub", () => {
  it("passes the same conformance kit as the in-process stub", async () => {
    const m = manifest();
    const report = await runConformance(
      { manifest: m, plugin: createSubprocessPlugin(m, STUB_DIR), dir: STUB_DIR },
      GOLDEN,
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  }, 30_000);

  it("kills a plugin that hangs at the timeout and reports a typed timeout", async () => {
    const plugin = createSubprocessPlugin(manifest(), STUB_DIR);
    await plugin.init({ secrets: {}, callTimeoutMs: 300 });
    const pid = plugin.pid as number;
    const started = Date.now();
    const response = await plugin.call({ id: "h", method: "hang" }, new AbortController().signal);
    expect(response).toMatchObject({ ok: false, error: { code: "timeout", retryable: true } });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await gone(pid, 2000)).toBe(true);
    await plugin.shutdown();
  }, 30_000);

  it("leaves no child alive when the host exits normally", async () => {
    const host = spawn(process.execPath, [
      HOST_CHILD,
      JSON.stringify(manifest()),
      STUB_DIR,
      "exit",
    ]);
    const pid = await new Promise<number>((resolve) =>
      host.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
    );
    await new Promise((r) => host.once("exit", r));
    expect(await gone(pid, 2000)).toBe(true);
  }, 30_000);

  it("leaves no child alive within 2 s when the host is killed with SIGKILL", async () => {
    const host = spawn(process.execPath, [
      HOST_CHILD,
      JSON.stringify(manifest()),
      STUB_DIR,
      "wait",
    ]);
    const pid = await new Promise<number>((resolve) =>
      host.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
    );
    expect(alive(pid)).toBe(true);
    host.kill("SIGKILL");
    expect(await gone(pid, 2000)).toBe(true);
  }, 30_000);

  it("loads a subprocess manifest through loadPlugin", async () => {
    const { loadPlugin } = await import("../src/index.js");
    const loaded = await loadPlugin(`${STUB_DIR}manifest.json`);
    expect(loaded.manifest.runtime.kind).toBe("subprocess");
  });
});

describe.skipIf(!run)("subprocess host stderr and work folder (F18, M4)", () => {
  it("returns the stderr tail of a failed call with declared secrets replaced", async () => {
    const m = manifest();
    m.secrets = ["STUB_TOKEN"];
    const lines: string[] = [];
    const plugin = createSubprocessPlugin(m, STUB_DIR);
    await plugin.init({
      secrets: { STUB_TOKEN: "tok-0123456789" },
      callTimeoutMs: 5000,
      onLog: (line) => lines.push(line),
    });
    const r = await plugin.call({ id: "f", method: "fail_loud" }, new AbortController().signal);
    await plugin.shutdown();
    expect(r.ok).toBe(false);
    const error = (r as { ok: false; error: { code: string; data?: { stderr?: string } } }).error;
    expect(error.code).toBe("provider_error");
    expect(error.data?.stderr).toContain("provider rejected token [secret:STUB_TOKEN]");
    expect(JSON.stringify(r)).not.toContain("tok-0123456789");
    expect(lines).toContain("provider rejected token [secret:STUB_TOKEN]");
  });

  it("creates a work folder when none is given and removes it at shutdown", async () => {
    const plugin = createSubprocessPlugin(manifest(), STUB_DIR);
    await plugin.init({ secrets: {}, callTimeoutMs: 5000 });
    const dir = plugin.workDir as string;
    expect(existsSync(dir)).toBe(true);
    const r = await plugin.call({ id: "w", method: "work_dir" }, new AbortController().signal);
    expect(r).toEqual({ ok: true, result: dir });
    await plugin.shutdown();
    expect(existsSync(dir)).toBe(false);
  });
});
