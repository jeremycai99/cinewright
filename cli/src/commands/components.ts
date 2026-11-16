import { catalogDir } from "@cinewright/components";
import { type Catalog, type JsonObject, loadCatalog } from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import type { Io } from "../io.js";

export const COMPONENTS_USAGE = "usage: cinewright components [<id>] [--json]";

let cached: Catalog | undefined;

/** The first-party component catalog (D31), loaded once per process. */
export function firstPartyCatalog(): Catalog {
  cached ??= loadCatalog(catalogDir);
  return cached;
}

function describeProp(schema: unknown): string {
  const s = (schema ?? {}) as JsonObject;
  if (typeof s["x-token-type"] === "string") return `{ token: <${s["x-token-type"]} path> }`;
  if (Array.isArray(s.enum)) return `one of: ${s.enum.join(", ")}`;
  if (s.type === "array") {
    const items = (s.items ?? {}) as JsonObject;
    return `list of ${String(items.type ?? "object")}`;
  }
  return String(s.type ?? "value");
}

/** `cinewright components [<id>]`: the component catalog agents choose from (D31). */
export async function components(argv: string[], io: Io): Promise<number> {
  const { positionals, values } = parse(argv, { json: { type: "boolean" } });
  if (positionals.length > 1) throw new UsageError("components takes at most one id");
  const catalog = firstPartyCatalog();
  const [id] = positionals;
  if (!id) {
    if (values.json) {
      const list = catalog.ids().map((i) => ({ id: i, summary: catalog.get(i)?.catalog.summary }));
      io.stdout(`${JSON.stringify(list, null, 2)}\n`);
      return EXIT.ok;
    }
    const lines = catalog.ids().map((i) => `  ${i}  ${catalog.get(i)?.catalog.summary ?? ""}`);
    io.stdout(
      `components (cinewright components <id> for props and regions):\n${lines.join("\n")}\n`,
    );
    return EXIT.ok;
  }
  const entry = catalog.get(id);
  if (!entry) throw new UsageError(`no component ${id}; components: ${catalog.ids().join(", ")}`);
  const { dir: _dir, ...shown } = entry;
  if (values.json) {
    io.stdout(`${JSON.stringify(shown, null, 2)}\n`);
    return EXIT.ok;
  }
  const props = (entry.props.properties ?? {}) as JsonObject;
  const required = new Set((entry.props.required as string[] | undefined) ?? []);
  const lines = [
    `${entry.id}  ${entry.name} (v${entry.version}, ${entry.runtime})`,
    entry.catalog.summary,
    `use when: ${entry.catalog.use_when}`,
    `avoid when: ${entry.catalog.avoid_when}`,
    "props (layer /props/<name>):",
    ...Object.entries(props).map(([name, schema]) => {
      const description = ((schema ?? {}) as JsonObject).description;
      return `  ${name}  ${describeProp(schema)}${required.has(name) ? "  (required)" : ""}${typeof description === "string" ? `  ${description}` : ""}`;
    }),
    "regions (shot template: layer region):",
    ...Object.entries(entry.templates).map(([t, regions]) => `  ${t}: ${regions.join(", ")}`),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT.ok;
}
