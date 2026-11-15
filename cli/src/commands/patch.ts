import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ApplyResult, type Author, projectFps, type Store } from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { describeOps } from "../show/diff.js";

export const PATCH_USAGE = [
  "usage: cinewright patch apply|propose --file <patch.json> [--project <dir>] [--frames] [--json]",
  "       cinewright patch approve <pending_id> [--project <dir>] [--json]",
  "       cinewright patch reject <pending_id> [--reason <text>] [--project <dir>] [--json]",
  "       cinewright patch list --pending [--project <dir>] [--json]",
  "       cinewright patch revert <revision> [--project <dir>] [--json]",
].join("\n");

const USER: Author = { kind: "user" };

/** Exit code for an apply result (cli/README.md). */
export function exitFor(result: ApplyResult): number {
  switch (result.status) {
    case "applied":
      return EXIT.ok;
    case "pending":
      return result.reason === "authorship_blocked" ? EXIT.blocked : EXIT.ok;
    case "rejected":
      return EXIT.invalid;
    case "conflict":
      return EXIT.conflict;
  }
}

function jsonOf(result: ApplyResult): Record<string, unknown> {
  switch (result.status) {
    case "applied":
      return { status: "applied", revision: result.revision, state_hash: result.stateHash };
    case "pending":
      return {
        status: "pending",
        pending_id: result.pendingId,
        reason: result.reason,
        ...(result.blocked ? { blocked: result.blocked } : {}),
      };
    case "rejected":
      return { status: "rejected", errors: result.errors };
    case "conflict":
      return { status: "conflict", conflicts: result.conflicts };
  }
}

function statusLines(result: ApplyResult): string[] {
  switch (result.status) {
    case "applied":
      return [`applied revision ${result.revision} (${result.stateHash})`];
    case "pending":
      return [
        `pending ${result.pendingId} (${result.reason})`,
        ...(result.blocked ?? []).map((b) => `  op ${b.op}: ${b.rule}`),
      ];
    case "rejected":
      return [
        "rejected:",
        ...result.errors.map(
          (e) =>
            `  op ${e.op ?? "-"} ${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}${e.message ? ` (${e.message})` : ""}`,
        ),
      ];
    case "conflict":
      return [
        "conflict:",
        ...result.conflicts.map(
          (c) => `  ${c.entity} ${c.path || "/"} changed in revision ${c.revision}`,
        ),
      ];
  }
}

async function report(
  io: Io,
  store: Store,
  before: ReturnType<Store["ir"]>,
  ops: Parameters<typeof describeOps>[2],
  result: ApplyResult,
  json: boolean,
  frames: boolean,
  title?: string,
): Promise<number> {
  if (json) printJson(io, jsonOf(result));
  else {
    const time = { fps: projectFps(before), frames };
    const after = result.status === "applied" ? store.ir() : null;
    const lines = [
      ...(title ? [title] : []),
      ...describeOps(before, after, ops, time),
      ...statusLines(result),
    ];
    io.stdout(`${lines.join("\n")}\n`);
  }
  return exitFor(result);
}

export async function patch(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, {
    project: { type: "string" },
    file: { type: "string" },
    reason: { type: "string" },
    pending: { type: "boolean" },
    frames: { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = values.json === true;
  const frames = values.frames === true;
  if (sub === "apply" || sub === "propose") {
    if (!values.file) throw new UsageError(`patch ${sub} needs --file <patch.json>`);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(
        readFileSync(values.file === "-" ? 0 : resolve(io.cwd, values.file), "utf8"),
      );
    } catch (error) {
      throw new UsageError(`cannot read ${values.file}: ${(error as Error).message}`);
    }
    const store = await openStore(io, findProject(io, values.project));
    const before = store.ir();
    const result = await store.apply({ ...body, mode: sub });
    const ops = Array.isArray(body.ops) ? (body.ops as Parameters<typeof describeOps>[2]) : [];
    return report(
      io,
      store,
      before,
      result.status === "rejected" && ops.length === 0 ? [] : ops,
      result,
      json,
      frames,
    );
  }
  if (sub === "approve" || sub === "reject") {
    const [id] = positionals;
    if (!id) throw new UsageError(`patch ${sub} needs a pending id`);
    const store = await openStore(io, findProject(io, values.project));
    const entry = store.pending().find((p) => p.pending_id === id);
    const before = store.ir();
    if (sub === "approve") {
      const result = await store.approve(id, USER);
      return report(io, store, before, entry?.ops ?? [], result, json, frames, `approve ${id}`);
    }
    const result = await store.reject(id, USER, values.reason);
    if (json)
      printJson(
        io,
        result.status === "recorded"
          ? { status: "recorded", decision: "rejected", pending_id: id }
          : result,
      );
    else
      io.stdout(
        result.status === "recorded" ? `rejected ${id}\n` : `${statusLines(result).join("\n")}\n`,
      );
    return result.status === "recorded" ? EXIT.ok : EXIT.invalid;
  }
  if (sub === "list") {
    if (!values.pending) throw new UsageError("patch list needs --pending");
    const store = await openStore(io, findProject(io, values.project));
    const pending = store.pending();
    if (json) printJson(io, { pending });
    else {
      for (const p of pending) {
        const who =
          p.author.kind === "agent"
            ? `agent:${p.author.role}`
            : p.author.kind === "job"
              ? `job:${p.author.name}`
              : p.author.kind;
        io.stdout(`${p.pending_id}  ${who}  ${p.reason_code}  ${p.reason}\n`);
      }
      if (pending.length === 0) io.stdout("no pending patches\n");
    }
    return EXIT.ok;
  }
  if (sub === "revert") {
    const revision = Number(positionals[0]);
    if (!Number.isInteger(revision) || revision < 1)
      throw new UsageError("patch revert needs a revision number");
    const store = await openStore(io, findProject(io, values.project));
    const result = await store.revert(revision, USER);
    if (json) printJson(io, jsonOf(result));
    else io.stdout(`${[`revert revision ${revision}`, ...statusLines(result)].join("\n")}\n`);
    return exitFor(result);
  }
  throw new UsageError(sub ? `unknown patch command ${sub}` : "patch needs a command");
}
