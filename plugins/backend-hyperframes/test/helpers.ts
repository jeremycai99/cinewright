import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogDir } from "@cinewright/components";
import { type Author, loadCatalog, loadPack, Store, type TimingTable } from "@cinewright/core";
import { afterEach } from "vitest";

const REFERENCE = fileURLToPath(
  new URL("../../../cli/test/fixtures/m1-reference/", import.meta.url),
);
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));
export const USER: Author = { kind: "user" };
const OPTIONS = { sessionId: "test", now: () => "2026-11-16T00:00:00Z" };

const dirs: string[] = [];
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-backend-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const timing = (): TimingTable =>
  JSON.parse(readFileSync(join(REFERENCE, "timing.json"), "utf8"));
export const catalog = () => loadCatalog(catalogDir);
export const pack = (id: string) => loadPack(id, [PACKS]);

/** A copy of the M1 reference project with the reference shot's layers placed in regions. */
export async function reference(extraOps: Record<string, unknown>[] = []): Promise<Store> {
  const dir = join(tempDir(), "project");
  cpSync(join(REFERENCE, "project"), dir, { recursive: true });
  const store = await Store.open(dir, OPTIONS);
  const regions = JSON.parse(readFileSync(join(FIXTURES, "regions.json"), "utf8"));
  regions.base_revision = store.revision();
  regions.ops.push(...extraOps);
  const result = await store.apply(regions);
  if (result.status !== "applied") throw new Error(`regions patch: ${JSON.stringify(result)}`);
  return store;
}

/**
 * Ops that make scene 3 end in a transition into a new scene-4 shot: s03.sh02 (Dr Lin, no layers)
 * gets a template, s04.sh01 starts where it ends, with a title.
 */
export function segmentOps(
  type: "cross_dissolve" | "wipe" | "cut",
  frames = 12,
): Record<string, unknown>[] {
  return [
    {
      op: "set",
      entity: "s03_the_problem",
      path: "/transition_out",
      value: { type, to: "s04", duration: frames },
    },
    { op: "set", entity: "s03.sh02", path: "/layout/landscape", value: { template: "full" } },
    { op: "set", entity: "s03.sh02", path: "/layout/portrait", value: { template: "full" } },
    {
      op: "insert",
      entity: "s04",
      path: "/shots",
      value: {
        id: "s04.sh01",
        type: "motion_graphics",
        framing: "full_frame",
        anchors: { start: { line: "b01.l02", point: "end", offset: 12 } },
        duration: 60,
        layout: { landscape: { template: "title" }, portrait: { template: "title" } },
        layers: [
          {
            id: "s04.sh01.title",
            component: "kinetic_title",
            props: { text: "Here is why." },
            layout: { landscape: { region: "title" }, portrait: { region: "title" } },
          },
        ],
      },
    },
  ];
}
