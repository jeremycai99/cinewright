import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type ComponentExample,
  type DeliveryProfile,
  loadCatalog,
  loadExamples,
  loadPack,
  profileRefPath,
  registryProfileNames,
} from "@cinewright/core";
import { catalogDir } from "../catalog-dir.js";
import { buildSpecimen } from "./specimen.js";

const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));

export interface SpecimenOptions {
  out: string;
  packs?: string[];
  profiles?: string[];
  components?: string[];
  /** An examples.json to use in place of each component's own. */
  examples?: string;
}

function names(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).filter(test).sort();
}

/**
 * Write a specimen composition for every pack × profile (each pack only with the aspect classes
 * it supports) holding every chosen component's examples, plus `samples.json`: the frame rate, the
 * times to check and each layer's frames. Returns what was written.
 */
export async function writeSpecimens(
  options: SpecimenOptions,
): Promise<{ dir: string; samples: number[] }[]> {
  const packIds = options.packs ?? names(PACKS, (n) => existsSync(join(PACKS, n, "pack.json")));
  const profileRefs = options.profiles ?? registryProfileNames();
  const catalog = loadCatalog(catalogDir);
  const componentIds = options.components ?? catalog.ids();
  const override = options.examples
    ? (JSON.parse(readFileSync(options.examples, "utf8")) as ComponentExample[])
    : undefined;
  const items = componentIds.flatMap((component) =>
    (override ?? loadExamples(join(catalogDir, component))).map((example) => ({
      component,
      example,
    })),
  );
  const written: { dir: string; samples: number[] }[] = [];
  for (const packId of packIds) {
    const pack = loadPack(packId, [PACKS]);
    for (const ref of profileRefs) {
      const profile = JSON.parse(
        readFileSync(profileRefPath(ref, process.cwd()), "utf8"),
      ) as DeliveryProfile;
      if (!pack.manifest.aspect_classes.includes(profile.aspect_class)) continue;
      const dir = join(options.out, packId, profile.id);
      mkdirSync(dir, { recursive: true });
      const result = await buildSpecimen({ pack, profile, examples: items, outDir: dir });
      const layers = result.spec.layers.map((l) => ({ id: l.id, ...l.timing }));
      writeFileSync(
        join(dir, "samples.json"),
        `${JSON.stringify({ fps: result.spec.fps, samples: result.samples, layers }, null, 2)}\n`,
      );
      written.push({ dir, samples: result.samples });
    }
  }
  return written;
}

/** `pnpm --filter @cinewright/components specimens -- --out <dir> [--pack id] [--profile name] [--component id] [--examples file]` */
export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      pack: { type: "string", multiple: true },
      profile: { type: "string", multiple: true },
      component: { type: "string", multiple: true },
      examples: { type: "string" },
    },
    strict: true,
  });
  if (!values.out) {
    console.error(
      "usage: specimens --out <dir> [--pack <id>] [--profile <name>] [--component <id>] [--examples <file>]",
    );
    return 2;
  }
  const written = await writeSpecimens({
    out: values.out,
    ...(values.pack ? { packs: values.pack } : {}),
    ...(values.profile ? { profiles: values.profile } : {}),
    ...(values.component ? { components: values.component } : {}),
    ...(values.examples ? { examples: values.examples } : {}),
  });
  for (const w of written) console.log(w.dir);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2).filter((a) => a !== "--"));
}
