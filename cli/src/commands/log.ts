import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DECISION_LOG, RUNS_DIR, runDir } from "@cinewright/core";
import { readFindingsLog, readSpend } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { latestRun } from "./review.js";

export const LOG_USAGE =
  "usage: cinewright log [--decisions | --patches | --events | --spend | --findings] [--entity <id>] [--run <id>] [--limit <n>] [--project <dir>] [--json]";

const lines = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

/**
 * `cinewright log` (M8.1): one of the project's logs. Decisions carry the entities their ops touch
 * (joined from the patch log by revision), so `--entity` finds a shot's decisions and citations.
 * Events are a run's (`--run`, default the latest). `--limit` keeps the newest.
 */
export async function log(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    decisions: { type: "boolean" },
    patches: { type: "boolean" },
    events: { type: "boolean" },
    spend: { type: "boolean" },
    findings: { type: "boolean" },
    entity: { type: "string" },
    run: { type: "string" },
    limit: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const kinds = (["decisions", "patches", "events", "spend", "findings"] as const).filter(
    (k) => values[k],
  );
  if (kinds.length > 1)
    throw new UsageError("choose one of --decisions, --patches, --events, --spend, --findings");
  const kind = kinds[0] ?? "patches";
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new UsageError("--limit takes a whole number above 0");
  const dir = findProject(io, values.project);
  const store = await openStore(io, dir);
  let rows: Record<string, unknown>[];
  if (kind === "decisions") {
    // Every entity id an inserted value carries, nested ones included.
    const carried = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) for (const v of value) carried(v, out);
      else if (value && typeof value === "object") {
        const o = value as Record<string, unknown>;
        if (typeof o.id === "string") out.push(o.id);
        for (const [k, v] of Object.entries(o)) if (k !== "id") carried(v, out);
      }
      return out;
    };
    type Touch = { entity: string; path?: string; carries?: string[] };
    const byRevision = new Map<number, Touch[]>();
    for (const e of store.log())
      if (e.kind === "applied")
        byRevision.set(
          e.revision,
          (e.ops as { op: string; entity: string; path?: string; value?: unknown }[]).map((o) => {
            const carries = o.op === "insert" ? carried(o.value) : [];
            return {
              entity: o.entity,
              ...(o.path ? { path: o.path } : {}),
              ...(carries.length > 0 ? { carries } : {}),
            };
          }),
        );
    rows = lines(join(dir, DECISION_LOG)).map((d) => {
      const ops = byRevision.get(d.revision as number) ?? [];
      const touched = (d.ops as number[] | undefined)?.map((i) => ops[i]).filter(Boolean) ?? [];
      return { ...d, touches: touched };
    });
    if (values.entity)
      rows = rows.filter((d) =>
        (d.touches as Touch[]).some((t) =>
          [t.entity, ...(t.carries ?? [])].some(
            (id) => id === values.entity || id.startsWith(`${values.entity}.`),
          ),
        ),
      );
  } else if (kind === "patches") {
    rows = store.log() as unknown as Record<string, unknown>[];
    if (values.entity)
      rows = rows.filter((e) =>
        ((e.ops as { entity: string }[] | undefined) ?? []).some((o) => o.entity === values.entity),
      );
  } else if (kind === "events") {
    const run = values.run ?? latestRun(dir);
    if (run === "none" || !existsSync(join(dir, RUNS_DIR, run)))
      throw new UsageError(`no run ${run}`);
    rows = lines(join(runDir(dir, run), "events.jsonl"));
  } else if (kind === "spend") {
    rows = readSpend(dir) as unknown as Record<string, unknown>[];
    if (values.run) rows = rows.filter((e) => e.run === values.run);
  } else {
    rows = readFindingsLog(dir) as unknown as Record<string, unknown>[];
    if (values.entity)
      rows = rows.filter(
        (e) =>
          (e.doc as { entity?: string } | undefined)?.entity === values.entity ||
          e.kind !== "raised",
      );
  }
  if (limit !== undefined) rows = rows.slice(-limit);
  if (values.json) printJson(io, { log: kind, entries: rows });
  else for (const r of rows) io.stdout(`${JSON.stringify(r)}\n`);
  return EXIT.ok;
}
