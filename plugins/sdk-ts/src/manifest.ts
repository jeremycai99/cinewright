import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type PluginKind =
  | "llm"
  | "tts"
  | "music"
  | "sfx"
  | "image"
  | "video"
  | "lipsync"
  | "stt"
  | "stock"
  | "backend"
  | "critic"
  | "exporter";

/** A plugin manifest (`plugins/sdk-ts/schema/manifest.schema.json`). */
export interface PluginManifest {
  schema_version: 1;
  id: string;
  version: string;
  kind: PluginKind;
  capabilities: string[];
  cost_model: { unit: string; usd_per_unit?: number };
  latency_class: "interactive" | "batch" | "offline";
  output_license: { terms: string; commercial_use: boolean; attribution?: string };
  secrets: string[];
  runtime:
    | { kind: "in_process"; entry: string }
    | {
        kind: "subprocess";
        command: string[];
        cwd?: string;
        /** Run inside a pinned image (M4); `image` is a logical name such as "audio". */
        container?: { image: string };
      };
  concurrency: { max_parallel: number };
  rate_limits: { requests: number; per_seconds: number }[];
}

export interface ManifestError {
  pointer: string;
  rule: string;
}

let validator: ValidateFunction | undefined;

function manifestValidator(): ValidateFunction {
  if (validator) return validator;
  const path = fileURLToPath(new URL("../schema/manifest.schema.json", import.meta.url));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  validator = ajv.compile(JSON.parse(readFileSync(path, "utf8")));
  return validator;
}

function pointerOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `${error.instancePath}/${params.missingProperty}`;
  }
  if (error.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    return `${error.instancePath}/${params.additionalProperty}`;
  }
  return error.instancePath;
}

/** Validate a manifest; errors name the JSON Pointer and the failing keyword (`schema.<keyword>`). */
export function validateManifest(
  manifest: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; errors: ManifestError[] } {
  const validate = manifestValidator();
  if (validate(manifest)) return { ok: true, manifest: manifest as PluginManifest };
  const errors = (validate.errors ?? [])
    .filter((e) => !e.schemaPath.includes("/oneOf/"))
    .map((e) => ({ pointer: pointerOf(e), rule: `schema.${e.keyword}` }));
  const unique = [...new Map(errors.map((e) => [`${e.pointer}|${e.rule}`, e])).values()];
  return { ok: false, errors: unique };
}
