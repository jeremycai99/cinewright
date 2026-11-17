import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  bundleRuntime,
  type LayerSpec,
  layerSeed,
  type MountSpec,
  writeComposition,
} from "@cinewright/components";
import {
  CascadeError,
  type Catalog,
  type InlinedIr,
  layerTiming,
  type Pack,
  PackError,
  type ResolvedToken,
  regionBox,
  resolveEntity,
  sha256Bytes,
  shotSpan,
  shotsInOrder,
  TimingError,
  type TimingTable,
  tokenEmit,
  UnsafeValueError,
  unwrap,
} from "@cinewright/core";
import { CompileError, type CompileIssue } from "./errors.js";
import { COMPILER_VERSION } from "./version.js";

/** Everything a compiled composition's frames depend on, besides the renderer (M3.2b). */
export interface CompileInputs {
  schema_version: 1;
  compiler: string;
  spec: MountSpec;
  root_css: Record<string, string>;
  /** Font file name → sha256. */
  fonts: Record<string, string>;
  /** sha256 of runtime.js. */
  runtime: string;
  /** Asset id → sha256 of the copied file. */
  assets: Record<string, string>;
  /** The delivery profile copy's hash. */
  profile: string;
  pack: { id: string; version: string; content_hash: string };
}

export interface PlanOptions {
  ir: InlinedIr;
  shotId: string;
  deliverableId: string;
  /** The project's pack: it must match the project's pin. */
  pack: Pack;
  catalog: Catalog;
  timing: TimingTable;
  /** Asset id → file, for assets the shot's layers name in their props. */
  assets?: Readonly<Record<string, string>>;
}

export interface CompileOptions extends PlanOptions {
  outDir: string;
}

/** A compiled shot before anything is written: what `compileShot` writes, and its inputs. */
export interface Plan {
  frames: number;
  spec: MountSpec;
  rootCss: Record<string, string>;
  /** Asset id → the file to copy into `assets/`. */
  copies: Record<string, { source: string; target: string }>;
  inputs: CompileInputs;
}

export interface Compiled {
  dir: string;
  /** The composition's length: the shot's span, in frames. */
  frames: number;
  spec: MountSpec;
  inputs: CompileInputs;
}

type Json = unknown;

function timingIssue(error: TimingError): CompileIssue {
  return {
    entity: error.entity ?? null,
    pointer: "",
    rule: error.rule === "timing.unknown_span" ? "compile.unknown_span" : error.rule,
    message: error.message,
  };
}

/** Run `fn`, turning core's typed errors into compile issues. */
function attempt<T>(issues: CompileIssue[], entity: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TimingError) issues.push(timingIssue(error));
    else if (error instanceof UnsafeValueError)
      issues.push({
        entity,
        pointer: "/style",
        rule: "compile.unsafe_value",
        message: error.message,
      });
    else if (error instanceof CascadeError)
      issues.push(
        ...error.errors.map((e) => ({
          entity: e.entity ?? entity,
          pointer: e.pointer,
          rule: e.rule,
        })),
      );
    else throw error;
    return undefined;
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
};

/** A file extension for a media type, so the browser can tell what a CAS file is. */
function extensionFor(mediaType: string | undefined): string {
  return (mediaType && EXTENSIONS[mediaType]) ?? "";
}

/** String prop values that name a given asset id, anywhere in the props. */
function assetIdsIn(value: Json, assets: Readonly<Record<string, string>>, out: Set<string>): void {
  if (typeof value === "string" && value in assets) out.add(value);
  else if (Array.isArray(value)) for (const v of value) assetIdsIn(v, assets, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) assetIdsIn(v, assets, out);
}

let runtime: Promise<string> | undefined;

/** sha256 of the bundled runtime (the host and every core component), built once per process. */
export function runtimeHash(): Promise<string> {
  runtime ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-runtime-"));
    try {
      await bundleRuntime(join(dir, "runtime.js"));
      return sha256Bytes(readFileSync(join(dir, "runtime.js")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return runtime;
}

/**
 * Plan one shot for one deliverable without writing anything (M3.1b, M3.2b): span → layer timing
 * → region boxes → each layer's tokens through the cascade → CSS through `cssValue` → mount spec,
 * and the compile inputs render key v1 hashes. Throws CompileError listing every problem it
 * found, or PackError when `pack` is not the project's pinned pack.
 */
export async function planShot(options: PlanOptions): Promise<Plan> {
  const { ir, shotId, deliverableId, pack, catalog, timing } = options;
  const assets = options.assets ?? {};

  const pinned = ir.style?.pack?.value;
  const pin = pinned ? ir.packs?.[pinned] : undefined;
  if (pinned !== pack.id || !pin) {
    throw new PackError([
      {
        pack: pack.id,
        file: "",
        pointer: "",
        rule: "pack.unpinned",
        message: `the project's pack is ${pinned ?? "unset"}`,
      },
    ]);
  }
  if (pin.hash !== pack.contentHash) {
    throw new PackError([
      {
        pack: pack.id,
        file: "",
        pointer: "",
        rule: "pack.pin_mismatch",
        message: `pinned ${pin.version} (${pin.hash}), found ${pack.version} (${pack.contentHash})`,
      },
    ]);
  }

  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const copy = profileId ? ir.profiles[profileId] : undefined;
  if (!copy) {
    throw new CompileError([
      { entity: deliverableId, pointer: "", rule: "compile.unknown_deliverable" },
    ]);
  }
  const profile = copy.body;
  const aspect = profile.aspect_class;
  const entry = shotsInOrder(ir).find((s) => s.shot.id === shotId);
  if (!entry)
    throw new CompileError([{ entity: shotId, pointer: "", rule: "compile.unknown_shot" }]);
  const shot = entry.shot;
  const rate = (f: { num: number; den: number }) => f.num / f.den;
  if (rate(timing.fps) !== rate(profile.frame_rate)) {
    throw new CompileError([
      {
        entity: deliverableId,
        pointer: "",
        rule: "compile.fps_mismatch",
        message: `the timing table is at ${timing.fps.num}/${timing.fps.den} fps, the project at ${profile.frame_rate.num}/${profile.frame_rate.den}`,
      },
    ]);
  }
  const registered = new Map((ir.assets.value ?? []).map((a) => [a.id, a]));

  const issues: CompileIssue[] = [];
  const span = attempt(issues, shotId, () => shotSpan(ir, shotId, timing));
  const shotStyle = attempt(issues, shotId, () =>
    resolveEntity(ir, shotId, deliverableId, pack.tokens),
  );
  if (!span || !shotStyle) throw new CompileError(issues);
  const rootCss = attempt(issues, shotId, () => tokenEmit(shotStyle.tokens, profile).css) ?? {};

  const template = (shotStyle.fields["/layout"]?.value as { template?: string } | undefined)
    ?.template;
  const variant = template ? pack.layouts.templates[template]?.variants[aspect] : undefined;
  if (!template || !variant) {
    issues.push({
      entity: shotId,
      pointer: `/layout/${aspect}`,
      rule: "compile.unknown_region",
      message: template
        ? `pack ${pack.id} has no template ${template} for ${aspect}`
        : `no template for ${aspect}`,
    });
    throw new CompileError(issues);
  }

  const layers: LayerSpec[] = [];
  const copied: Record<string, string> = {};
  const copies: Plan["copies"] = {};
  for (const layer of shot.layers?.value ?? []) {
    const id = layer.id;
    const component = layer.component?.value;
    const entryOf = component ? catalog.get(component) : undefined;
    if (!component || !entryOf) {
      issues.push({ entity: id, pointer: "/component", rule: "compile.unknown_component" });
      continue;
    }
    const props = (unwrap(layer.props ?? {}) ?? {}) as Record<string, unknown>;
    for (const name of (entryOf.props.required as string[] | undefined) ?? []) {
      if (!(name in props))
        issues.push({ entity: id, pointer: `/props/${name}`, rule: "compile.missing_prop" });
    }
    const region = (
      layer.layout?.[aspect as keyof typeof layer.layout] as
        | { value?: { region?: string } }
        | undefined
    )?.value?.region;
    const regionDef = region ? variant.regions[region] : undefined;
    if (!region || !regionDef) {
      issues.push({
        entity: id,
        pointer: `/layout/${aspect}`,
        rule: "compile.unknown_region",
        message: region
          ? `template ${template} has no region ${region}`
          : `no region for ${aspect}`,
      });
      continue;
    }
    const times = attempt(issues, id, () => layerTiming(ir, id, timing));
    const style = attempt(issues, id, () => resolveEntity(ir, id, deliverableId, pack.tokens));
    if (!times || !style) continue;
    const emitted = attempt(issues, id, () =>
      tokenEmit(style.tokens as Record<string, ResolvedToken>, profile),
    );
    if (!emitted) continue;
    const css = Object.fromEntries(
      Object.entries(emitted.css).filter(([k, v]) => rootCss[k] !== v),
    );

    const named = new Set<string>();
    assetIdsIn(props, assets, named);
    const wanted = new Set<string>();
    assetIdsIn(props, Object.fromEntries([...registered.keys()].map((k) => [k, k])), wanted);
    for (const assetId of [...wanted].sort())
      if (!(assetId in assets))
        issues.push({
          entity: id,
          pointer: "/props",
          rule: "compile.missing_asset",
          message: `asset ${assetId} has no file (it is not in the project's CAS)`,
        });
    const layerAssets: Record<string, string> = {};
    for (const assetId of [...named].sort()) {
      const source = assets[assetId] as string;
      const target = `assets/${assetId}${extname(source) || extensionFor(registered.get(assetId)?.media_type)}`;
      if (!(assetId in copied)) {
        copies[assetId] = { source, target };
        copied[assetId] = sha256Bytes(readFileSync(source));
      }
      layerAssets[assetId] = target;
    }

    layers.push({
      id,
      component,
      box: regionBox(pack, template, region, profile),
      align: regionDef.align ?? "start",
      justify: regionDef.justify ?? "start",
      props,
      css,
      js: emitted.js,
      timing: times,
      motion: (unwrap(layer.motion) as LayerSpec["motion"] | undefined) ?? [],
      seed: layerSeed(id),
      captions: profile.captions,
      ...(Object.keys(layerAssets).length > 0 ? { assets: layerAssets } : {}),
    });
  }
  if (issues.length > 0) throw new CompileError(issues);

  const frames = span.end - span.start;
  const spec: MountSpec = {
    fps: profile.frame_rate,
    width: profile.width,
    height: profile.height,
    aspect,
    layers,
  };
  const inputs: CompileInputs = {
    schema_version: 1,
    compiler: COMPILER_VERSION,
    spec,
    root_css: rootCss,
    fonts: Object.fromEntries(pack.fonts.map((f) => [basename(f.file), f.sha256])),
    runtime: await runtimeHash(),
    assets: copied,
    profile: copy.hash,
    pack: { id: pack.id, version: pack.version, content_hash: pack.contentHash },
  };
  return { frames, spec, rootCss, copies, inputs };
}

/**
 * Compile one shot for one deliverable into a HyperFrames composition (M3.1b, D31): `planShot`,
 * then the mount spec written by the components package's `writeComposition`, with the assets
 * its layers name copied in. Throws as `planShot` does.
 */
export async function compileShot(options: CompileOptions): Promise<Compiled> {
  const { pack, shotId, outDir } = options;
  const plan = await planShot(options);
  mkdirSync(outDir, { recursive: true });
  for (const { source, target } of Object.values(plan.copies)) {
    mkdirSync(join(outDir, "assets"), { recursive: true });
    copyFileSync(source, join(outDir, target));
  }
  await writeComposition({
    pack,
    spec: plan.spec,
    rootCss: plan.rootCss,
    compositionId: shotId,
    frames: plan.frames,
    outDir,
  });
  const written = sha256Bytes(readFileSync(join(outDir, "runtime.js")));
  if (written !== plan.inputs.runtime)
    throw new Error(`runtime.js hash ${written} differs from the planned ${plan.inputs.runtime}`);
  return { dir: outDir, frames: plan.frames, spec: plan.spec, inputs: plan.inputs };
}
