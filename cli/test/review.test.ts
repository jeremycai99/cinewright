import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z" };

async function project(beats = true): Promise<string> {
  const dir = join(tempDir(), "demo");
  const init = ["init", dir, "--id", "demo", "--pack", "neutral"];
  const profile = `web=${PROFILES}landscape_1080p30.json`;
  expect((await run([...init, "--deliverable", profile], ENV)).code).toBe(0);
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
          entity: "demo",
          path: "/cast",
          value: {
            id: "narrator",
            role: "narrator",
            display_name: "Narrator",
            voice: { description: { language: "en" } },
            performance: { baseline: "steady" },
            on_screen: false,
          },
        },
        ...(beats
          ? [
              {
                op: "insert",
                entity: "script",
                path: "/beats",
                value: {
                  id: "b01",
                  summary: "S",
                  lines: [{ id: "b01.l01", text: "Hello there.", speaker: "narrator" }],
                },
              },
            ]
          : []),
      ],
    }),
  );
  expect((await run(["patch", "apply", "--file", file, "--project", dir], ENV)).code).toBe(0);
  return dir;
}

const json = async (argv: string[]) => {
  const r = await run([...argv, "--json"], ENV);
  expect(r.code, r.stderr).toBe(EXIT.ok);
  return JSON.parse(r.stdout);
};

describe("cinewright review and tasks (M7.6)", () => {
  it("lists unapproved gates as tasks, shows the packet, approves and records a reject note", async () => {
    const dir = await project();
    const p = ["--project", dir];
    const ids = (await json(["tasks", ...p])).map((t: { id: string }) => t.id);
    expect(ids).toContain("gate:script");

    const packet = await json(["review", "script", ...p]);
    expect(packet).toMatchObject({ gate: "script", run: "none", diff: [], suggestions: [] });
    expect(packet.locks.some((l: { state: string }) => l.state !== "locked")).toBe(true);

    expect((await run(["review", "approve", "script", ...p], ENV)).code).toBe(EXIT.ok);
    const after = await json(["review", "script", ...p]);
    expect(after.locks.every((l: { state: string }) => l.state === "locked")).toBe(true);
    expect(after.since).toBe(after.revision);
    const left = (await json(["tasks", ...p])).map((t: { id: string }) => t.id);
    expect(left).not.toContain("gate:script");

    const note = ["review", "reject", "storyboard", "--note", "Tighter cuts", ...p];
    expect((await json(note)).seq).toBeGreaterThan(0);
  });

  it("refuses an unknown gate, a reject without a note, and variants before roles exist", async () => {
    const dir = await project();
    const p = ["--project", dir];
    expect((await run(["review", "soon", ...p], ENV)).code).toBe(EXIT.usage);
    expect((await run(["review", "reject", "script", ...p], ENV)).code).toBe(EXIT.usage);
    expect((await run(["review", "variants", "script", "b01.l01", ...p], ENV)).code).toBe(
      EXIT.provider,
    );
    expect((await run(["tasks", "show", "nope", ...p], ENV)).code).toBe(EXIT.usage);
  });

  it("review budget shows spent, the cap and the estimate, and --cap raises the cap (M7.7)", async () => {
    const dir = await project();
    const p = ["--project", dir];
    const before = await json(["review", "budget", ...p]);
    expect(before).toMatchObject({ spent_usd: 0, cap_usd: 5 });
    expect(before.estimate.total_usd).toBeGreaterThanOrEqual(0);
    const after = await json(["review", "budget", "--cap", "12.5", ...p]);
    expect(after.cap_usd).toBe(12.5);
    expect((await json(["review", "script", ...p])).cost.cap_usd).toBe(12.5);
    expect((await run(["review", "budget", "--cap", "-1", ...p], ENV)).code).toBe(EXIT.usage);
  });
});

describe("cinewright tasks submit (M7.5a)", () => {
  it("applies a human Producer's and Writer's output after the role's checks", async () => {
    const dir = await project(false);
    const p = ["--project", dir];
    const roles = join(tempDir(), "roles.json");
    writeFileSync(
      roles,
      JSON.stringify({
        base_revision: 1,
        author: { kind: "user" },
        mode: "apply",
        reason: "people in both seats",
        ops: [
          {
            op: "set",
            entity: "demo",
            path: "/settings/roles",
            value: { producer: "human", writer: "human" },
          },
        ],
      }),
    );
    expect((await run(["patch", "apply", "--file", roles, ...p], ENV)).code).toBe(0);
    const ids = (await json(["tasks", ...p])).map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["producer", "writer"]));

    const file = (name: string, value: unknown) => {
      const f = join(tempDir(), name);
      writeFileSync(f, JSON.stringify(value));
      return f;
    };
    const plan = file("plan.json", {
      plan: { summary: "Why heat pumps work", target_seconds: 10, beats: ["Heat moves"] },
    });
    expect((await run(["tasks", "submit", "producer", "--file", plan, ...p], ENV)).code).toBe(
      EXIT.ok,
    );
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const script = (n: number) => ({
      beats: [
        {
          id: "b02",
          summary: "Heat moves",
          lines: [0, 1, 2, 3].map((i) => ({ id: `b02.l0${i + 1}`, text: words(n) })),
        },
      ],
    });
    const long = file("long.json", script(60));
    const bad = await run(["tasks", "submit", "writer", "--file", long, ...p], ENV);
    expect(bad.code).toBe(EXIT.invalid);
    expect(bad.stderr).toContain("script.too_long");
    const good = file("good.json", script(5));
    const ok = await run(["tasks", "submit", "writer", "--file", good, ...p], ENV);
    expect(ok.code, ok.stderr).toBe(EXIT.ok);
    const left = (await json(["tasks", ...p])).map((t: { id: string }) => t.id);
    expect(left).not.toContain("writer");
  });
});

describe("cinewright review waive (M6.3b)", () => {
  it("waives an escalated error, refuses a clearance finding, and reports whether export may proceed", async () => {
    const { sign } = await import("@cinewright/core");
    const { FindingsLedger } = await import("@cinewright/engine");
    const dir = await project();
    const p = ["--project", dir];
    const make = (rule: string, entity: string) =>
      sign(
        { rule, severity: "error", entity, message: rule, data: {} },
        { critic: { id: "t", version: "1" }, deliverable: "web", evidence: {}, key: rule },
      );
    const overflow = make("layout.overflow", "b01.l01");
    const consent = make("clearance.consent_missing", "narrator");
    const ledger = new FindingsLedger(dir);
    await ledger.raise([overflow, consent], 1, "run_1");
    await ledger.escalate(overflow.id, "attempts", "final");
    const before = await json(["review", "final", ...p]);
    expect(before.escalated.map((e: { finding: string }) => e.finding)).toEqual([overflow.id]);
    expect(before.exportable).toBe(false);
    const waive = ["review", "waive", overflow.id, "--note", "Reads fine at full size", ...p];
    expect((await run(waive, ENV)).code).toBe(EXIT.ok);
    const refused = await run(["review", "waive", consent.id, "--note", "x", ...p], ENV);
    expect(refused.code).toBe(EXIT.invalid);
    expect(refused.stderr).toContain("cannot be waived");
    // The consent finding still blocks export.
    expect((await json(["review", "final", ...p])).exportable).toBe(false);
    expect((await run(["review", "waive", "f_000000000000", "--note", "x", ...p], ENV)).code).toBe(
      EXIT.usage,
    );
  });
});
