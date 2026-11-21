import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Catalog,
  type Finding,
  finding,
  type InlinedIr,
  type SolvedTiming,
  type Store,
  sha256Hash,
  solveTiming,
  stateHash,
  type TokenTree,
} from "@cinewright/core";
import type { PluginResponse } from "@cinewright/plugin-sdk";
import { ComposeError, compose } from "../jobs/composer.js";
import { NarrationError, narrate } from "../jobs/narration.js";
import { backendFor } from "../plugins/backend.js";
import { PluginChoiceError, pluginWith } from "../plugins/call.js";
import { PluginCallError, PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { manifestFor } from "./manifest.js";
import { STAGES, type Stage } from "./plan.js";

export interface StepRecord {
  id: string;
  kind: string;
  key: string;
  hit: boolean;
  ms: number;
}

export interface DeliverableReport {
  file: string;
  sha256: string;
  framemd5: string;
  pcm_sha256: string;
  frames: number;
  captions: { srt: string; vtt: string };
  mix_key: string;
  assembly_key: string;
  shots: { id: string; backend: string; version: string; key: string }[];
  manifest?: string;
}

export interface RenderReport {
  revision: number;
  state_hash: string;
  steps: StepRecord[];
  deliverables: Record<string, DeliverableReport>;
  findings: Finding[];
  /** The last stage that ran (`--until`). */
  until: Stage;
}

export interface RenderOptions {
  deliverables?: readonly string[];
  until?: Stage;
  retake?: readonly string[];
  provider?: string;
  /** The render image reference. */
  image: string;
  /** Copy each deliverable's files and manifest here. */
  out?: string;
  plugins: {
    tts: readonly FoundPlugin[];
    stt: readonly FoundPlugin[];
    music: readonly FoundPlugin[];
    sfx: readonly FoundPlugin[];
    backend: readonly FoundPlugin[];
    exporter: readonly FoundPlugin[];
  };
  pack: { tokens: TokenTree };
  catalog: Catalog;
  env?: Readonly<Record<string, string | undefined>>;
  onEvent?: (step: StepRecord) => void;
}

/** Why a run stopped: IR or compile findings (exit 3), a render failure (8), a provider (9). */
export class PipelineError extends Error {
  override name = "PipelineError";
  constructor(
    readonly kind: "invalid" | "render" | "provider",
    readonly step: string,
    message: string,
    readonly findings: Finding[] = [],
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const reached = (until: Stage, stage: Stage) => STAGES.indexOf(stage) <= STAGES.indexOf(until);

/**
 * `cinewright render` (M5.4b): every non-agent job in order, serially, re-doing only what an
 * edit changed. Narration and the Composer are the M4 jobs; timing is `solveTiming`; shots,
 * segments, the mix, captions and assembly go through plugins, whose caches decide hits.
 * Error findings stop the run after the step that reports them.
 */
export async function runRender(store: Store, options: RenderOptions): Promise<RenderReport> {
  const env = options.env ?? process.env;
  const until = options.until ?? "assemble";
  const steps: StepRecord[] = [];
  const findings: Finding[] = [];
  const record = (step: StepRecord) => {
    steps.push(step);
    options.onEvent?.(step);
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const t0 = Date.now();
    const value = await fn();
    return [value, Date.now() - t0];
  };

  // narrate
  try {
    const [narrated, ms] = await timed(() =>
      narrate(store, {
        tts: options.plugins.tts,
        stt: options.plugins.stt,
        env,
        ...(options.retake ? { retake: options.retake } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
      }),
    );
    for (const r of narrated.made)
      record({ id: `narrate:${r.line}`, kind: "narrate", key: r.take, hit: false, ms });
    for (const r of narrated.reused)
      record({ id: `narrate:${r.line}`, kind: "narrate", key: r.take, hit: true, ms: 0 });
    findings.push(...narrated.findings);
    stopOnErrors("narrate", narrated.findings);
  } catch (error) {
    if (error instanceof NarrationError) {
      throw new PipelineError("provider", `narrate:${error.line}`, error.message, [], error.error);
    }
    throw error;
  }
  const report = (): RenderReport => ({
    revision: store.revision(),
    state_hash: stateHash(store.ir()),
    steps,
    deliverables,
    findings,
    until,
  });
  const deliverables: Record<string, DeliverableReport> = {};
  if (!reached(until, "timing")) return report();

  // timing (and again after compose, which adds no timing input)
  const solve = (): Omit<SolvedTiming, "findings"> => {
    const { findings: f, ...solved } = solveTiming(store.ir(), options.pack, options.catalog);
    const errors = f.filter((x) => x.severity === "error");
    record({ id: "timing", kind: "timing", key: sha256Hash(solved).slice(7), hit: true, ms: 0 });
    findings.push(...f);
    stopOnErrors("timing", errors);
    return solved;
  };
  const timing = solve();
  if (!reached(until, "compose")) return report();

  // compose: music is optional, so with no music or SFX plugin there is nothing to do.
  const composing = options.plugins.music.length > 0 || options.plugins.sfx.length > 0;
  if (composing)
    try {
      const [composed, ms] = await timed(() =>
        compose(store, {
          music: options.plugins.music,
          sfx: options.plugins.sfx,
          pack: options.pack,
          catalog: options.catalog,
          env,
        }),
      );
      for (const r of composed.made)
        record({ id: `compose:${r.owner}`, kind: "compose", key: r.asset, hit: false, ms });
      for (const r of composed.reused)
        record({ id: `compose:${r.owner}`, kind: "compose", key: r.asset, hit: true, ms: 0 });
      // Music is optional: a sequence with no matching bed still renders, without one.
      findings.push(
        ...composed.findings.map((f) =>
          f.rule === "compose.no_match" ? { ...f, severity: "warning" as const } : f,
        ),
      );
    } catch (error) {
      if (error instanceof ComposeError)
        throw new PipelineError("provider", `compose:${error.owner}`, error.message);
      throw error;
    }
  if (!reached(until, "shots")) return report();

  const ir = store.ir();
  const wanted = (ir.deliverables.value ?? [])
    .map((d) => d.id)
    .filter((id) => !options.deliverables || options.deliverables.includes(id));
  for (const id of options.deliverables ?? []) {
    if (!wanted.includes(id))
      throw new PipelineError("invalid", `deliverable:${id}`, `no deliverable ${id}`);
  }
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-render-"));
  const pool = new PluginPool({ env, workDir, callTimeoutMs: 3_600_000 });
  try {
    for (const deliverable of wanted) {
      deliverables[deliverable] = await renderDeliverable(
        store,
        ir,
        deliverable,
        timing,
        options,
        pool,
        record,
        until,
      );
      if (options.out && reached(until, "assemble")) {
        const entry = deliverables[deliverable] as DeliverableReport;
        mkdirSync(options.out, { recursive: true });
        copyFileSync(entry.file, join(options.out, `${deliverable}.mp4`));
        copyFileSync(
          entry.captions.srt,
          join(options.out, entry.captions.srt.split("/").at(-1) as string),
        );
        copyFileSync(
          entry.captions.vtt,
          join(options.out, entry.captions.vtt.split("/").at(-1) as string),
        );
        const manifest = join(options.out, `${deliverable}.manifest.json`);
        writeFileSync(
          manifest,
          `${JSON.stringify(manifestFor(store, deliverable, entry, options.image), null, 2)}\n`,
        );
        entry.manifest = manifest;
      }
    }
  } finally {
    await pool.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
  return report();
}

function stopOnErrors(step: string, list: readonly Finding[]): void {
  const errors = list.filter((f) => f.severity === "error");
  if (errors.length > 0) {
    throw new PipelineError(
      "invalid",
      step,
      `${step} reported ${errors.map((f) => `${f.rule} ${f.entity}`).join(", ")}`,
      errors,
    );
  }
}

async function call(
  pool: PluginPool,
  plugin: FoundPlugin,
  method: string,
  params: unknown,
  step: string,
  kind: "render" | "provider",
) {
  try {
    return await pool.call(plugin, method, params);
  } catch (error) {
    if (error instanceof PluginCallError) {
      const data = error.error.data as
        | { issues?: { entity?: string | null; rule: string; message?: string }[]; rule?: string }
        | undefined;
      if (error.error.code === "invalid_request") {
        const issues = data?.issues ?? [
          { entity: step, rule: data?.rule ?? "invalid_request", message: error.error.message },
        ];
        const list = issues.map((i) =>
          finding(i.rule, "error", i.entity ?? step, i.message ?? i.rule),
        );
        throw new PipelineError("invalid", step, error.message, list, data);
      }
      throw new PipelineError(kind, step, error.message, [], data);
    }
    throw error;
  }
}

async function renderDeliverable(
  store: Store,
  ir: InlinedIr,
  deliverable: string,
  timing: Omit<SolvedTiming, "findings">,
  options: RenderOptions,
  pool: PluginPool,
  record: (s: StepRecord) => void,
  until: Stage,
): Promise<DeliverableReport> {
  const common = { project: store.dir, deliverable, timing, image: options.image };
  const parts: {
    kind: "body" | "segment";
    id: string;
    key: string;
    file: string;
    frames: number;
    framemd5: string;
  }[] = [];
  const shots: DeliverableReport["shots"] = [];
  // Every shot first: a segment renders the shots it needs, and would hide their misses.
  const bodies = new Map<string, (typeof parts)[number]>();
  const outgoing = new Set<string>();
  for (const sequence of ir.sequences.value ?? []) {
    for (const scene of sequence.scenes?.value ?? []) {
      for (const shot of scene.shots?.value ?? []) {
        let backend: FoundPlugin;
        try {
          backend = backendFor(ir, shot.id, options.plugins.backend);
        } catch (error) {
          if (error instanceof PluginChoiceError) {
            throw new PipelineError("invalid", `render:${shot.id}@${deliverable}`, error.message, [
              finding(error.rule, "error", shot.id, error.message),
            ]);
          }
          throw error;
        }
        const step = `render:${shot.id}@${deliverable}`;
        const plan = (await call(
          pool,
          backend,
          "render.plan",
          { ...common, shot: shot.id },
          step,
          "render",
        )) as {
          key: string;
          segments: { outgoing?: string };
        };
        const t0 = Date.now();
        const r = (await call(
          pool,
          backend,
          "render.shot",
          { ...common, shot: shot.id },
          step,
          "render",
        )) as {
          key: string;
          dir: string;
          body_frames: number;
          hit: boolean;
        };
        record({ id: step, kind: "render", key: r.key, hit: r.hit, ms: Date.now() - t0 });
        shots.push({
          id: shot.id,
          backend: backend.manifest.id,
          version: backend.manifest.version,
          key: plan.key,
        });
        bodies.set(shot.id, {
          kind: "body",
          id: shot.id,
          key: r.key,
          file: join(r.dir, "body.mp4"),
          frames: r.body_frames,
          framemd5: readFileSync(join(r.dir, "framemd5.txt"), "utf8"),
        });
        if (plan.segments.outgoing === scene.id) outgoing.add(scene.id);
      }
    }
  }
  // Segments render after every shot, so a segment never renders a shot first and hides that
  // shot's own miss; then the parts go in timeline order.
  for (const sequence of ir.sequences.value ?? []) {
    for (const scene of sequence.scenes?.value ?? []) {
      for (const shot of scene.shots?.value ?? [])
        parts.push(bodies.get(shot.id) as (typeof parts)[number]);
      if (outgoing.has(scene.id)) {
        const last = (scene.shots?.value ?? []).at(-1)?.id as string;
        const backend = backendFor(ir, last, options.plugins.backend);
        const step = `segment:${scene.id}@${deliverable}`;
        const t0 = Date.now();
        const s = (await call(
          pool,
          backend,
          "render.segment",
          { ...common, scene: scene.id },
          step,
          "render",
        )) as {
          key: string;
          dir: string;
          frames: number;
          hit: boolean;
        };
        record({ id: step, kind: "segment", key: s.key, hit: s.hit, ms: Date.now() - t0 });
        parts.push({
          kind: "segment",
          id: scene.id,
          key: s.key,
          file: join(s.dir, "segment.mp4"),
          frames: s.frames,
          framemd5: readFileSync(join(s.dir, "framemd5.txt"), "utf8"),
        });
      }
    }
  }
  const empty: DeliverableReport = {
    file: "",
    sha256: "",
    framemd5: "",
    pcm_sha256: "",
    frames: timing.frames,
    captions: { srt: "", vtt: "" },
    mix_key: "",
    assembly_key: "",
    shots,
  };
  if (!reached(until, "mix")) return empty;

  const mixer = pickOrThrow(options.plugins.backend, "mix.render", `mix@${deliverable}`);
  let t0 = Date.now();
  const mix = (await call(pool, mixer, "mix.render", common, `mix@${deliverable}`, "render")) as {
    key: string;
    dir: string;
    hit: boolean;
    pcm_sha256: string;
  };
  record({
    id: `mix@${deliverable}`,
    kind: "mix",
    key: mix.key,
    hit: mix.hit,
    ms: Date.now() - t0,
  });
  if (!reached(until, "captions"))
    return { ...empty, pcm_sha256: mix.pcm_sha256, mix_key: mix.key };

  const captioner = pickOrThrow(
    options.plugins.exporter,
    "export.captions",
    `captions@${deliverable}`,
  );
  t0 = Date.now();
  const captions = (await call(
    pool,
    captioner,
    "export.captions",
    { project: store.dir, deliverable, timing },
    `captions@${deliverable}`,
    "render",
  )) as {
    key: string;
    files: { srt: string; vtt: string };
    hit: boolean;
  };
  record({
    id: `captions@${deliverable}`,
    kind: "captions",
    key: captions.key,
    hit: captions.hit,
    ms: Date.now() - t0,
  });
  if (!reached(until, "assemble"))
    return { ...empty, pcm_sha256: mix.pcm_sha256, mix_key: mix.key, captions: captions.files };

  const profileId = (ir.deliverables.value ?? []).find((d) => d.id === deliverable)?.profile
    .value as string;
  const rate = ir.profiles[profileId]?.body.sample_rate as number;
  const fps = timing.table.fps;
  const samples = Math.floor((timing.frames * rate * fps.den) / fps.num);
  const exporter = pickOrThrow(options.plugins.exporter, "export.mp4", `assemble@${deliverable}`);
  t0 = Date.now();
  const assembled = (await call(
    pool,
    exporter,
    "export.mp4",
    { ...common, parts, mix: { key: mix.key, file: join(mix.dir, "master.wav"), samples } },
    `assemble@${deliverable}`,
    "render",
  )) as {
    key: string;
    file: string;
    sha256: string;
    framemd5: string;
    frames: number;
    hit: boolean;
  };
  record({
    id: `assemble@${deliverable}`,
    kind: "assemble",
    key: assembled.key,
    hit: assembled.hit,
    ms: Date.now() - t0,
  });
  return {
    file: assembled.file,
    sha256: assembled.sha256,
    framemd5: assembled.framemd5,
    pcm_sha256: mix.pcm_sha256,
    frames: assembled.frames,
    captions: captions.files,
    mix_key: mix.key,
    assembly_key: assembled.key,
    shots,
  };
}

function pickOrThrow(
  plugins: readonly FoundPlugin[],
  capability: string,
  step: string,
): FoundPlugin {
  try {
    return pluginWith(plugins, capability);
  } catch (error) {
    if (error instanceof PluginChoiceError) throw new PipelineError("invalid", step, error.message);
    throw error;
  }
}

export type { PluginResponse };
