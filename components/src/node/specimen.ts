import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type ComponentExample,
  type DeliveryProfile,
  type Pack,
  type ResolvedToken,
  regionBox,
  resolvePackTokens,
  tokenEmit,
} from "@cinewright/core";
import { catalogDir } from "../catalog-dir.js";
import type { LayerSpec, MountSpec } from "../host/spec.js";
import { bundleRuntime } from "./bundle.js";

export interface SpecimenItem {
  component: string;
  example: ComponentExample;
}

export interface SpecimenResult {
  dir: string;
  /** Times to check, in seconds: each example's entrance midpoint, hold midpoint and last frame. */
  samples: number[];
  spec: MountSpec;
}

/** A clip the specimen checker generates in the container (`generated.json`); never committed. */
export interface GeneratedAsset {
  path: string;
  lavfi: string;
}

/**
 * Copy an example's assets (files in its component folder) into the composition; a `{ file, lavfi }`
 * asset is listed in `generated` for the checker to make with the image's FFmpeg.
 */
function copyAssets(
  component: string,
  assets: NonNullable<ComponentExample["assets"]>,
  outDir: string,
  generated: GeneratedAsset[],
): Record<string, string> {
  const out: Record<string, string> = {};
  mkdirSync(join(outDir, "assets", component), { recursive: true });
  for (const [id, source] of Object.entries(assets)) {
    if (typeof source === "string") {
      const target = `assets/${component}/${basename(source)}`;
      copyFileSync(join(catalogDir, component, source), join(outDir, target));
      out[id] = target;
    } else {
      const target = `assets/${component}/${source.file}`;
      generated.push({ path: target, lavfi: source.lavfi });
      out[id] = target;
    }
  }
  return out;
}

function seedOf(id: string): number {
  return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

function fontFaces(pack: Pack): string {
  return pack.fonts
    .map((font) =>
      [
        "@font-face {",
        `  font-family: ${JSON.stringify(font.family)};`,
        `  src: url("fonts/${basename(font.file)}") format("woff2");`,
        `  font-weight: ${font.weight[0]} ${font.weight[1]};`,
        `  font-style: ${font.style};`,
        "  font-display: block;",
        ...(font.unicode_range ? [`  unicode-range: ${font.unicode_range};`] : []),
        "}",
      ].join("\n"),
    )
    .join("\n");
}

function declarations(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Write a HyperFrames composition that shows each example in turn, under one pack and one
 * delivery profile (M2.4a). Examples carry no pack values, so switching `pack` is the only change
 * between two packs' specimens. Returns the mount spec and the times worth checking.
 */
export async function buildSpecimen(options: {
  pack: Pack;
  profile: DeliveryProfile;
  examples: readonly SpecimenItem[];
  outDir: string;
}): Promise<SpecimenResult> {
  const { pack, profile, examples, outDir } = options;
  const aspect = profile.aspect_class;
  const fps = profile.frame_rate;
  const frames = (ms: number) => Math.round((ms * fps.num) / (fps.den * 1000));
  const seconds = (f: number) => (f * fps.den) / fps.num;
  const base = resolvePackTokens(pack, aspect);
  const baseCss = tokenEmit(base, profile).css;

  let cursor = 0;
  const layers: LayerSpec[] = [];
  const generated: GeneratedAsset[] = [];
  const samples = new Set<number>();
  const entranceMs = base["motion.duration.m"]?.value as number;
  for (const { component, example } of examples) {
    const id = `${component}.${example.name}`;
    const tokens: Record<string, ResolvedToken> = example.overrides
      ? resolvePackTokens(pack, aspect, [
          { origin: { level: "layer", entity: id }, overrides: example.overrides },
        ])
      : base;
    const emitted = tokenEmit(tokens, profile);
    const css = Object.fromEntries(
      Object.entries(emitted.css).filter(([k, v]) => baseCss[k] !== v),
    );
    const region =
      pack.layouts.templates[example.template]?.variants[aspect]?.regions[example.region];
    const enter = cursor;
    const end = cursor + Math.max(1, frames(example.duration_ms));
    cursor = end;
    layers.push({
      id,
      component,
      box: regionBox(pack, example.template, example.region, profile),
      align: region?.align ?? "start",
      justify: region?.justify ?? "start",
      props: example.props,
      css,
      js: emitted.js,
      timing: { enter, end },
      motion: (example.motion ?? []) as LayerSpec["motion"],
      seed: seedOf(id),
      captions: profile.captions,
      ...(example.assets
        ? { assets: copyAssets(component, example.assets, outDir, generated) }
        : {}),
    });
    const startS = seconds(enter);
    const durationMs = (seconds(end) - startS) * 1000;
    for (const t of [
      startS + Math.min(entranceMs, durationMs / 4) / 2000,
      startS + durationMs / 2000,
      seconds(end - 1),
    ])
      samples.add(Math.round(t * 1000) / 1000);
  }
  const spec: MountSpec = { fps, width: profile.width, height: profile.height, aspect, layers };

  mkdirSync(join(outDir, "fonts"), { recursive: true });
  for (const font of pack.fonts)
    copyFileSync(join(pack.dir, font.file), join(outDir, "fonts", basename(font.file)));
  await bundleRuntime(join(outDir, "runtime.js"));

  const rate = fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
  const clips = layers
    .map((layer, i) => {
      const box = `left: ${layer.box.x}px; top: ${layer.box.y}px; width: ${layer.box.width}px; height: ${layer.box.height}px;`;
      const style = escapeAttr(`${box} ${declarations(layer.css)}`.trim());
      return `      <div id="cw-${layer.id}" class="clip cw-layer" data-start="${seconds(layer.timing.enter)}" data-duration="${seconds(layer.timing.end) - seconds(layer.timing.enter)}" data-track-index="${i}" style="${style}"></div>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${profile.width}, height=${profile.height}" />
    <style>
${fontFaces(pack)}
:root { ${declarations(baseCss)} }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${profile.width}px; height: ${profile.height}px; overflow: hidden; background: var(--palette-bg); }
#root { position: relative; width: 100%; height: 100%; background: var(--palette-bg); }
.cw-layer { position: absolute; }
    </style>
    <script src="runtime.js"></script>
  </head>
  <body>
    <div id="root" data-composition-id="specimen" data-start="0" data-duration="${seconds(cursor)}" data-width="${profile.width}" data-height="${profile.height}" data-fps="${rate}" data-no-timeline>
${clips}
    </div>
    <script>window.cinewright.mount(${JSON.stringify(spec).replace(/</g, "\\u003c")});</script>
  </body>
</html>
`;
  writeFileSync(join(outDir, "index.html"), html);
  if (generated.length > 0)
    writeFileSync(join(outDir, "generated.json"), `${JSON.stringify(generated, null, 2)}\n`);
  return { dir: outDir, samples: [...samples].sort((a, b) => a - b), spec };
}
