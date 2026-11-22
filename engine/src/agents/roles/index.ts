import type { Catalog, Pack } from "@cinewright/core";
import type { ToPatch } from "../runner.js";
import type { SemanticCheck } from "../validate.js";
import { directorCheck, directorToPatch } from "./director.js";
import { producerCheck, producerSuggest, producerToPatch } from "./producer.js";
import { writerCheck, writerToPatch } from "./writer.js";

/**
 * The engine side of the v0.1 roles (M7.5a–c): each role's `toPatch`, its semantic checks and
 * what it may only suggest. The Shot Builder and Editor join in M7.5c.
 */
export const ROLE_TO_PATCH: Readonly<Record<string, ToPatch>> = {
  producer: producerToPatch,
  writer: writerToPatch,
  director: directorToPatch,
};

export const ROLE_SUGGEST: Readonly<Record<string, ToPatch>> = { producer: producerSuggest };

export function roleChecks(
  pack: Pack,
  installedPacks: readonly string[],
  catalog?: Catalog,
): Readonly<Record<string, SemanticCheck>> {
  return {
    producer: producerCheck(installedPacks),
    writer: writerCheck(pack),
    ...(catalog ? { director: directorCheck(pack, catalog) } : {}),
  };
}
