import type { Catalog, Pack } from "@cinewright/core";
import type { OutputFor } from "../executor.js";
import type { ToPatch } from "../runner.js";
import { shotOutputSchema } from "../schema/layers.js";
import type { SemanticCheck } from "../validate.js";
import { directorCheck, directorToPatch } from "./director.js";
import { editorCheck, editorToPatch } from "./editor.js";
import { producerCheck, producerSuggest, producerToPatch } from "./producer.js";
import { shotBuilderCheck, shotBuilderToPatch } from "./shot_builder.js";
import { writerCheck, writerToPatch } from "./writer.js";

/**
 * The engine side of the v0.1 roles (M7.5a–c): each role's `toPatch`, its semantic checks and
 * what it may only suggest.
 */
export const ROLE_TO_PATCH: Readonly<Record<string, ToPatch>> = {
  producer: producerToPatch,
  writer: writerToPatch,
  director: directorToPatch,
  shot_builder: shotBuilderToPatch,
  editor: editorToPatch,
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
    editor: editorCheck(pack),
    ...(catalog
      ? { director: directorCheck(pack, catalog), shot_builder: shotBuilderCheck(pack, catalog) }
      : {}),
  };
}

/** Roles whose output schema depends on the task: the Shot Builder's, built from the catalog. */
export function roleOutputs(catalog: Catalog): Readonly<Record<string, OutputFor>> {
  return { shot_builder: shotOutputSchema(catalog) };
}
