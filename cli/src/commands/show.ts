import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CascadeError,
  indexIr,
  projectFps,
  resolveEntity,
  splitIr,
  type TokenTree,
  toStoredForm,
} from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import type { Io } from "../io.js";
import { findProject, openStore } from "../project.js";
import { flow } from "../show/format.js";
import { renderEntity } from "../show/view.js";

export const SHOW_USAGE =
  "usage: cinewright show [<id>] [--depth <n>] [--frames] [--resolved --pack <tokens.json> [--deliverable <id>]] [--json] [--project <dir>]";

export async function show(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    project: { type: "string" },
    depth: { type: "string" },
    frames: { type: "boolean" },
    resolved: { type: "boolean" },
    pack: { type: "string" },
    deliverable: { type: "string" },
    json: { type: "boolean" },
  });
  if (positionals.length > 1) throw new UsageError("show takes at most one entity id");
  const depth = values.depth === undefined ? 1 : Number(values.depth);
  if (!Number.isInteger(depth) || depth < 0) throw new UsageError("--depth must be a whole number");
  if (values.resolved && !values.pack)
    throw new UsageError("--resolved needs --pack <tokens.json>");
  const store = await openStore(io, findProject(io, values.project));
  const ir = store.ir();
  const id = positionals[0] ?? ir.id;
  const entity = indexIr(ir).get(id);
  if (!entity) {
    io.stderr(`cinewright show: no entity ${id}\n`);
    return EXIT.invalid;
  }
  if (values.json) {
    io.stdout(toStoredForm(id === ir.id ? splitIr(ir).project : entity.node));
    return EXIT.ok;
  }
  let text = renderEntity(ir, id, {
    depth,
    fps: projectFps(ir),
    frames: values.frames === true,
    pending: store.pending(),
  });
  if (values.resolved && values.pack) {
    const pack = JSON.parse(readFileSync(resolve(io.cwd, values.pack), "utf8")) as TokenTree;
    const deliverable = values.deliverable ?? ir.deliverables.value?.[0]?.id ?? "";
    try {
      const resolved = resolveEntity(ir, id, deliverable, pack);
      const origin = (o: { level: string; entity?: string }) =>
        o.level === "pack" ? "pack" : `${o.level} ${o.entity}`;
      const lines = [`resolved for ${deliverable}:`, "  tokens:"];
      for (const [path, t] of Object.entries(resolved.tokens))
        lines.push(`    ${path}: ${flow(t.value)}  # ${origin(t.origin)}`);
      lines.push("  fields:");
      for (const [pointer, f] of Object.entries(resolved.fields)) {
        const used = Object.entries(f.tokens)
          .map(([p, o]) => `${p}: ${origin(o)}`)
          .join("; ");
        lines.push(`    ${pointer}: ${flow(f.value)}${used ? `  # ${used}` : ""}`);
      }
      text += `${lines.join("\n")}\n`;
    } catch (error) {
      if (!(error instanceof CascadeError)) throw error;
      io.stderr(`cinewright show: ${error.message}\n`);
      return EXIT.invalid;
    }
  }
  io.stdout(text);
  return EXIT.ok;
}
