import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { catalogDir } from "@cinewright/components";
import {
  COMPILED_DIR,
  type InlinedIr,
  loadCatalog,
  PackError,
  packSearchPath,
  RENDER_CACHE_DIR,
  type RendererInfo,
  renderKeyV1,
  resolveEntity,
  resolveProjectPack,
  SEGMENT_CACHE_DIR,
  Store,
  TimingError,
  type TimingTable,
  validateTimingTable,
} from "@cinewright/core";
import type { Plugin, PluginError, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { projectAssets } from "./assets.js";
import { checkShot } from "./check.js";
import { type Compiled, compileShot, planShot } from "./compile.js";
import { CompileError } from "./errors.js";
import { captureKeyframes } from "./keyframes.js";
import {
  RenderError,
  type Rendered,
  renderCacheKey,
  renderShot,
  resolveRenderer,
} from "./render.js";
import { type Blend, renderSegment } from "./segment.js";

const METHODS = [
  "render.plan",
  "render.composition",
  "render.shot",
  "render.segment",
  "render.keyframes",
  "render.check",
] as const;
type Method = (typeof METHODS)[number];

/** Params every method takes (BACKEND_KIND in the SDK). */
interface Common {
  project: string;
  deliverable: string;
  timing: { table: TimingTable };
  image: string;
  pack_path?: string[];
}

interface Context {
  p: Common;
  ir: InlinedIr;
  pack: ReturnType<typeof resolveProjectPack>;
  catalog: ReturnType<typeof loadCatalog>;
  table: TimingTable;
  assets: Record<string, string>;
}

const err = (
  code: PluginError["code"],
  message: string,
  data?: unknown,
  retryable = false,
): PluginResponse => ({
  ok: false,
  error: { code, message, retryable, ...(data === undefined ? {} : { data }) },
});

const issue = (entity: string | null, pointer: string, rule: string, message: string) =>
  new CompileError([{ entity, pointer, rule, message }]);

/**
 * A thrown error as the typed plugin error (M5.4a): compile, pack and timing errors are
 * `invalid_request` with `data.issues`; render errors are `provider_error` with `data.rule`,
 * retryable only for `render.failed`; anything else is `internal`.
 */
export function toPluginError(error: unknown): PluginResponse {
  if (error instanceof CompileError || error instanceof PackError) {
    return err("invalid_request", error.message, { issues: error.errors });
  }
  if (error instanceof TimingError) {
    const one = {
      entity: error.entity ?? null,
      pointer: "",
      rule: error.rule,
      message: error.message,
    };
    return err("invalid_request", error.message, { issues: [one] });
  }
  if (error instanceof RenderError) {
    const data = { rule: error.rule, entity: error.shot };
    return err("provider_error", error.message, data, error.rule === "render.failed");
  }
  return err("internal", String((error as Error).stack ?? error));
}

/**
 * The HyperFrames backend (invariant 5, M5.4a). Six methods over the M3 functions; every one
 * takes the project folder, ids and the solved timing (D32). Compile and timing errors are
 * `invalid_request` with `data.issues`; render failures are `provider_error` with `data.rule`,
 * retryable only for `render.failed`.
 */
export function createPlugin(): Plugin {
  const renderers = new Map<string, Promise<RendererInfo>>();
  const renderer = (image: string): Promise<RendererInfo> => {
    let r = renderers.get(image);
    if (!r) {
      r = resolveRenderer(image);
      renderers.set(image, r);
    }
    return r;
  };

  /** Every method needs the project, deliverable and timing; all but `render.composition` render. */
  async function context(params: unknown, needsImage = true): Promise<Context> {
    const p = (params ?? {}) as Partial<Common>;
    if (!p.project || !p.deliverable || !p.timing?.table || (needsImage && !p.image)) {
      throw issue(
        null,
        "",
        "backend.params",
        "every method needs project, deliverable, timing and image",
      );
    }
    if (validateTimingTable(p.timing.table).length > 0) {
      throw issue(null, "/timing/table", "backend.timing", "not a timing table");
    }
    const ir = (await Store.open(p.project)).ir();
    const env = { CINEWRIGHT_PACK_PATH: (p.pack_path ?? []).join(delimiter) };
    return {
      p: p as Common,
      ir,
      pack: resolveProjectPack(ir, packSearchPath(env)),
      catalog: loadCatalog(catalogDir),
      table: p.timing.table,
      assets: projectAssets(ir, p.project),
    };
  }

  const planOptions = (ctx: Context, shotId: string) => ({
    ir: ctx.ir,
    shotId,
    deliverableId: ctx.p.deliverable,
    pack: ctx.pack,
    catalog: ctx.catalog,
    timing: ctx.table,
    assets: ctx.assets,
  });

  async function compile(ctx: Context, shotId: string, outDir: string): Promise<Compiled> {
    return compileShot({ ...planOptions(ctx, shotId), outDir });
  }

  /**
   * Compile into a scratch folder of its own (two renders of one shot may run at once), call
   * `fn`, then remove the folder: compiled compositions are inputs, never cache entries.
   */
  async function withCompiled<T>(
    ctx: Context,
    shotId: string,
    fn: (c: Compiled) => Promise<T>,
  ): Promise<T> {
    const scratch = join(ctx.p.project, COMPILED_DIR, `.tmp-${randomUUID()}`);
    try {
      return await fn(await compile(ctx, shotId, join(scratch, `${shotId}.${ctx.p.deliverable}`)));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async function shot<T>(
    ctx: Context,
    shotId: string,
    then: (compiled: Compiled, rendered: Rendered) => Promise<T>,
  ): Promise<T> {
    return withCompiled(ctx, shotId, async (compiled) => {
      const rendered = await renderShot({
        compiled,
        shotId,
        renderer: await renderer(ctx.p.image),
        cacheDir: join(ctx.p.project, RENDER_CACHE_DIR),
      });
      return then(compiled, rendered);
    });
  }

  async function segmentOf(
    ctx: Context,
    sceneId: string,
    from: { compiled: Compiled; rendered: Rendered },
    to: { compiled: Compiled; rendered: Rendered },
  ) {
    const segment = from.compiled.segments.outgoing;
    if (!segment)
      throw issue(
        sceneId,
        "/transition_out",
        "render.no_segment",
        "the scene's transition is a cut",
      );
    const tokens = resolveEntity(ctx.ir, sceneId, ctx.p.deliverable, ctx.pack.tokens).tokens;
    const blend: Blend =
      segment.type === "wipe"
        ? {
            type: "wipe",
            direction: tokens["transition.wipe.direction"]?.value as "left",
            softness: tokens["transition.wipe.softness"]?.value as number,
          }
        : { type: "cross_dissolve" };
    const done = await renderSegment({
      segment,
      from,
      to,
      blend,
      easing: String(tokens["motion.ease.standard"]?.value),
      renderer: await renderer(ctx.p.image),
      cacheDir: join(ctx.p.project, SEGMENT_CACHE_DIR),
    });
    return { ...done, frames: segment.end - segment.start };
  }

  const handlers: Record<Method, (params: unknown) => Promise<unknown>> = {
    async "render.plan"(params) {
      const ctx = await context(params);
      const plan = await planShot(planOptions(ctx, (params as { shot: string }).shot));
      const key = renderKeyV1({ compile: plan.inputs, renderer: await renderer(ctx.p.image) });
      return {
        key: key.slice("sha256:".length),
        frames: plan.frames,
        body: plan.timeline.body,
        segments: {
          ...(plan.segments.incoming ? { incoming: plan.segments.incoming.scene } : {}),
          ...(plan.segments.outgoing ? { outgoing: plan.segments.outgoing.scene } : {}),
        },
      };
    },
    async "render.composition"(params) {
      const ctx = await context(params, false);
      const { shot: shotId, out_dir } = params as { shot: string; out_dir: string };
      const compiled = await compile(ctx, shotId, out_dir);
      return { dir: compiled.dir, inputs: compiled.inputs, frames: compiled.frames };
    },
    async "render.shot"(params) {
      const ctx = await context(params);
      return shot(ctx, (params as { shot: string }).shot, async (compiled, rendered) => ({
        ...rendered,
        frames: compiled.frames,
        body_frames: compiled.timeline.body.end - compiled.timeline.body.start,
      }));
    },
    async "render.segment"(params) {
      const ctx = await context(params);
      const sceneId = (params as { scene: string }).scene;
      const scenes =
        (ctx.ir.sequences.value ?? []).find((s) =>
          (s.scenes?.value ?? []).some((sc) => sc.id === sceneId),
        )?.scenes?.value ?? [];
      const at = scenes.findIndex((sc) => sc.id === sceneId);
      const fromShot = scenes[at]?.shots?.value?.at(-1)?.id;
      const toShot = scenes[at + 1]?.shots?.value?.[0]?.id;
      if (!fromShot || !toShot)
        throw issue(sceneId, "", "render.no_segment", "no next scene to blend into");
      return shot(ctx, fromShot, (fromCompiled, fromRendered) =>
        shot(ctx, toShot, async (toCompiled, toRendered) => {
          const from = { compiled: fromCompiled, rendered: fromRendered };
          const to = { compiled: toCompiled, rendered: toRendered };
          return segmentOf(ctx, sceneId, from, to);
        }),
      );
    },
    async "render.keyframes"(params) {
      const ctx = await context(params);
      const info = await renderer(ctx.p.image);
      return shot(ctx, (params as { shot: string }).shot, async (compiled, rendered) => ({
        key: renderCacheKey(compiled, info),
        keyframes: await captureKeyframes({ compiled, rendered, renderer: info }),
      }));
    },
    async "render.check"(params) {
      const ctx = await context(params);
      const info = await renderer(ctx.p.image);
      return shot(ctx, (params as { shot: string }).shot, async (compiled, rendered) => {
        const { file, doc, hit } = await checkShot({ compiled, rendered, renderer: info });
        return {
          file,
          hit,
          failures: doc.failures,
          boxes: doc.samples.map((s) => ({ frame: s.frame, boxes: s.boxes })),
        };
      });
    },
  };

  return {
    async init() {},
    async capabilities() {
      // `backend.html`: the shot backend family this plugin renders (shot.backend = "html").
      return ["backend.html", ...METHODS];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      const handler = handlers[request.method as Method];
      if (!handler) return err("unsupported", `no method ${request.method}`);
      try {
        return { ok: true, result: await handler(request.params) };
      } catch (error) {
        return toPluginError(error);
      }
    },
    async shutdown() {},
  };
}
