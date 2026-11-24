import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z", CINEWRIGHT_IMAGE: "unused" };
const README = new URL("../README.md", import.meta.url).pathname;
const SCHEMA = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), "utf8"),
  ) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const valid = (name: string, doc: unknown) => {
  const v = compiled.get(name) ?? ajv.compile(SCHEMA(name));
  compiled.set(name, v);
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

async function project(): Promise<string> {
  const dir = join(tempDir(), "demo");
  const init = ["init", dir, "--id", "demo", "--pack", "neutral"];
  expect(
    (await run([...init, "--deliverable", `web=${PROFILES}landscape_1080p30.json`], ENV)).code,
  ).toBe(0);
  const file = join(tempDir(), "setup.json");
  writeFileSync(
    file,
    JSON.stringify({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "setup",
      ops: [
        {
          op: "insert",
          entity: "script",
          path: "/beats",
          value: { id: "b01", summary: "S", lines: [{ id: "b01.l01", text: "Hello there." }] },
        },
      ],
      decisions: [{ ops: [0], choice: "open with a greeting", citations: ["brief"] }],
    }),
  );
  const r = await run(["patch", "apply", "--file", file, "--project", dir], ENV);
  expect(r.code, r.stderr).toBe(0);
  return dir;
}

describe("the command list (M8.1)", () => {
  it("--help lists every command, and the README's command block equals it", async () => {
    const help = (await run(["--help"], ENV)).stdout;
    const fromHelp = help
      .split("\n")
      .filter((l) => /^(usage: |\s+)cinewright /.test(l))
      .map((l) => l.replace(/^(usage: |\s+)/, ""));
    for (const command of [
      "plan",
      "render",
      "review",
      "export",
      "status",
      "tasks",
      "log",
      "assets",
      "doctor",
    ])
      expect(
        fromHelp.some((l) => l.startsWith(`cinewright ${command} `)),
        command,
      ).toBe(true);
    const readme = readFileSync(README, "utf8");
    const block = readme.slice(
      readme.indexOf("## Commands\n\n```\n") + "## Commands\n\n```\n".length,
    );
    const fromReadme = block.slice(0, block.indexOf("```")).trim().split("\n");
    expect(fromReadme).toEqual(fromHelp);
  });
});

describe("status, log, assets and export (M8.1)", () => {
  it("print JSON that validates against cli/schema", async () => {
    const dir = await project();
    const p = ["--project", dir];
    const status = JSON.parse((await run(["status", ...p, "--json"], ENV)).stdout);
    expect(valid("status", status)).toEqual([]);
    for (const kind of ["--patches", "--decisions", "--spend", "--findings"]) {
      const out = JSON.parse((await run(["log", kind, ...p, "--json"], ENV)).stdout);
      expect(valid("log", out), kind).toEqual([]);
    }
    const prune = JSON.parse(
      (await run(["assets", "prune", "--dry-run", ...p, "--json"], ENV)).stdout,
    );
    expect(valid("assets", prune)).toEqual([]);
  });

  it("log --decisions --entity lists that entity's decisions with their citations; --limit keeps the newest", async () => {
    const dir = await project();
    const p = ["--project", dir];
    const out = JSON.parse(
      (await run(["log", "--decisions", "--entity", "b01", ...p, "--json"], ENV)).stdout,
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ choice: "open with a greeting", citations: ["brief"] });
    expect(out.entries[0].touches[0].entity).toBe("script");
    const none = JSON.parse(
      (await run(["log", "--decisions", "--entity", "s99", ...p, "--json"], ENV)).stdout,
    );
    // The beat was inserted into the script, so the decision touches `script`, and b01 under it.
    expect(none.entries).toHaveLength(0);
    const patches = JSON.parse((await run(["log", "--limit", "1", ...p, "--json"], ENV)).stdout);
    expect(patches.entries).toHaveLength(1);
    expect((await run(["log", "--spend", "--findings", ...p], ENV)).code).toBe(EXIT.usage);
    expect((await run(["log", "--limit", "0", ...p], ENV)).code).toBe(EXIT.usage);
  });

  it("export refuses while an error finding is open, naming it, and writes nothing (Review Focus 2)", async () => {
    const { sign } = await import("@cinewright/core");
    const { FindingsLedger } = await import("@cinewright/engine");
    const dir = await project();
    const f = sign(
      {
        rule: "layout.overflow",
        severity: "error",
        entity: "b01.l01",
        message: "too long",
        data: {},
      },
      { critic: { id: "t", version: "1" }, deliverable: "web", evidence: {}, key: "x" },
    );
    await new FindingsLedger(dir).raise([f], 1, "run_1");
    const out = join(tempDir(), "out");
    const r = await run(["export", "--to", out, "--project", dir], ENV);
    expect(r.code).toBe(EXIT.findings);
    expect(r.stderr).toContain(`layout.overflow b01.l01 [${f.id}]`);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    const json = JSON.parse(
      (await run(["export", "--to", out, "--project", dir, "--json"], ENV)).stdout,
    );
    expect(valid("export", json)).toEqual([]);
    expect(json.status).toBe("blocked");
    expect((await run(["export", "--project", dir], ENV)).code).toBe(EXIT.usage);
  });

  it("export refuses after a run paused, naming the pause, and writes nothing (the tier B measured run)", async () => {
    // In the second measured run (2026-11-24) render paused at the cap with Shot Builder tasks
    // pending; export then rendered the half-built shots and failed with a compile error.
    const { mkdirSync } = await import("node:fs");
    const { runDir } = await import("@cinewright/core");
    const dir = await project();
    const id = "run_20261124T042501Z";
    mkdirSync(runDir(dir, id), { recursive: true });
    const pause = { kind: "budget", id: "shot_builder:s01.sh01", amounts: {} };
    writeFileSync(
      join(runDir(dir, id), "outcome.json"),
      JSON.stringify({ status: "paused", pause }),
    );
    const out = join(tempDir(), "out");
    const r = await run(["export", "--to", out, "--project", dir], ENV);
    expect(r.code).toBe(EXIT.blocked);
    expect(r.stderr).toContain(`run ${id} paused at budget shot_builder:s01.sh01`);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    const json = JSON.parse(
      (await run(["export", "--to", out, "--project", dir, "--json"], ENV)).stdout,
    );
    expect(valid("export", json)).toEqual([]);
    expect(json).toMatchObject({
      status: "blocked",
      run: id,
      pause: { kind: "budget", id: "shot_builder:s01.sh01" },
    });
  });
});

describe("doctor (M8.5)", () => {
  it("prints a report that matches its schema, names missing keys by name, and exits 0 or 3 by ok", async () => {
    const r = await run(["doctor", "--json"], { CINEWRIGHT_CAS_REMOTE: "file:///nowhere/x/{hex}" });
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: { id: string; ok: boolean; required: boolean; detail: string }[];
    };
    expect(valid("doctor", report)).toEqual([]);
    expect(r.code).toBe(report.ok ? EXIT.ok : EXIT.invalid);
    const llm = report.checks.find((c) => c.id === "plugin.llm_anthropic");
    expect(llm).toMatchObject({ ok: false, required: false });
    expect(llm?.detail).toContain("ANTHROPIC_API_KEY");
    expect(report.checks.find((c) => c.id === "cas_remote")).toMatchObject({ ok: false });
    for (const id of ["docker", "image.render", "image.audio", "node"])
      expect(report.checks.find((c) => c.id === id)?.required, id).toBe(true);
  });

  it("names an image it cannot find with the command that pulls it", async () => {
    const r = await run(["doctor"], { CINEWRIGHT_IMAGE: "cinewright-render:never-built" });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stdout).toMatch(/FAIL image\.render: .*never-built/);
    expect(r.stdout).toContain("docker pull --platform linux/amd64 cinewright-render:never-built");
  });
});
