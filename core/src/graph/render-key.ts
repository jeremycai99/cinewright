import { type HashString, sha256Hash } from "../canonical/hash.js";
import { resolveEntity, type TokenTree } from "../cascade/resolve.js";
import type { InlinedIr } from "../ir/inlined.js";
import { type IrEntity, indexIr, isObject } from "../ir/paths.js";
import type { JsonObject } from "../schema/load.js";

/** The versions and digest a render depends on; real values arrive with M2–M3 (opaque here). */
export interface RenderInputs {
  pack: TokenTree;
  componentVersions: Readonly<Record<string, string>>;
  backendVersion: string;
  containerDigest: string;
}

const STATES = new Set(["open", "agent", "user", "locked"]);

export function isWrapper(value: unknown): value is { state: string; value?: unknown } {
  return (
    isObject(value) &&
    typeof value.state === "string" &&
    STATES.has(value.state) &&
    Object.keys(value).every((k) => k === "state" || k === "value")
  );
}

function isTokenRef(value: unknown): value is { token: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.token === "string";
}

/**
 * The IR node without authorship: wrappers become their values (open fields disappear), and
 * `origin` and `locked` are dropped. States and locks never change what renders.
 */
export function unwrap(value: unknown, tokens?: Record<string, { value: unknown }>): unknown {
  if (Array.isArray(value)) return value.map((v) => unwrap(v, tokens));
  if (!isObject(value)) return value;
  if (tokens && isTokenRef(value)) return tokens[value.token]?.value ?? value;
  if (isWrapper(value)) return "value" in value ? unwrap(value.value, tokens) : undefined;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "origin" || key === "locked") continue;
    const v = unwrap(child, tokens);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** A shot or layer as it renders for one deliverable: no states, tokens resolved, layout picked. */
function resolvedSpec(
  ir: InlinedIr,
  entity: IrEntity,
  deliverableId: string,
  pack: TokenTree,
): JsonObject {
  const resolved = resolveEntity(ir, entity.id, deliverableId, pack);
  const { layers, layout, style: _style, ...rest } = entity.node;
  const spec = unwrap(rest, resolved.tokens) as JsonObject;
  const variant = resolved.fields["/layout"];
  if (variant) spec.layout = variant.value as JsonObject;
  if (isWrapper(layers) && Array.isArray(layers.value)) {
    const index = indexIr(ir);
    spec.layers = layers.value.map((layer) => {
      const layerEntity = index.get((layer as JsonObject).id as string);
      return layerEntity ? resolvedSpec(ir, layerEntity, deliverableId, pack) : unwrap(layer);
    });
  }
  return spec;
}

function strings(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * The render key of a shot for a deliverable (M1.5): the hash of its resolved spec (states
 * stripped; only the tokens it and its layers use, resolved), the hashes of the assets it
 * references, the versions of the components it uses, the backend version, the container
 * digest and the deliverable's profile hash. Key order never matters (hash form, D30).
 */
export function renderKey(
  ir: InlinedIr,
  shotId: string,
  deliverableId: string,
  inputs: RenderInputs,
): HashString {
  const index = indexIr(ir);
  const shot = index.get(shotId);
  if (shot?.kind !== "shot") throw new Error(`no shot ${shotId}`);
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const profile = profileId ? ir.profiles[profileId] : undefined;
  if (!profile) throw new Error(`no deliverable ${deliverableId} with a profile`);
  const spec = resolvedSpec(ir, shot, deliverableId, inputs.pack);
  const assets: Record<string, string> = {};
  const byId = new Map((ir.assets.value ?? []).map((a) => [a.id, a.hash]));
  for (const s of strings(spec)) {
    const hash = byId.get(s);
    if (hash) assets[s] = hash;
  }
  const components: Record<string, string> = {};
  for (const layer of (spec.layers as JsonObject[] | undefined) ?? []) {
    const id = layer.component;
    if (typeof id === "string") components[id] = inputs.componentVersions[id] ?? "unversioned";
  }
  return sha256Hash({
    shot: spec,
    assets,
    components,
    backend: inputs.backendVersion,
    container: inputs.containerDigest,
    profile: profile.hash,
  });
}
