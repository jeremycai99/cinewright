import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z" };

async function project(): Promise<string> {
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
});
