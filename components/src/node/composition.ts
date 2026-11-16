import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Pack } from "@cinewright/core";
import type { MountSpec } from "../host/spec.js";
import { bundleRuntime } from "./bundle.js";

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

/** A layer's mulberry32 seed: the first 32 bits of the SHA-256 of its id. */
export function layerSeed(id: string): number {
  return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

/** Escape text for a double-quoted HTML attribute. */
export function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Write a HyperFrames composition for a mount spec (M3.1b): `index.html`, `runtime.js` (the host
 * and every core component) and the pack's fonts. Specimens and the shot compiler both call it,
 * so the background on `#root`, `data-no-timeline` and the readiness promise hold for both.
 * `rootCss` is the frame-wide CSS variables; each layer's own differ from it (`LayerSpec.css`).
 * Every value must already be safe for CSS (core's `cssValue`).
 */
export async function writeComposition(options: {
  pack: Pack;
  spec: MountSpec;
  rootCss: Record<string, string>;
  compositionId: string;
  /** The composition's length in frames. */
  frames: number;
  outDir: string;
}): Promise<void> {
  const { pack, spec, rootCss, compositionId, frames, outDir } = options;
  const { fps, width, height } = spec;
  const seconds = (f: number) => (f * fps.den) / fps.num;

  mkdirSync(join(outDir, "fonts"), { recursive: true });
  for (const font of pack.fonts)
    copyFileSync(join(pack.dir, font.file), join(outDir, "fonts", basename(font.file)));
  await bundleRuntime(join(outDir, "runtime.js"));

  const rate = fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
  const clips = spec.layers
    .map((layer, i) => {
      const box = `left: ${layer.box.x}px; top: ${layer.box.y}px; width: ${layer.box.width}px; height: ${layer.box.height}px;`;
      const style = escapeAttr(`${box} ${declarations(layer.css)}`.trim());
      return `      <div id="cw-${escapeAttr(layer.id)}" class="clip cw-layer" data-start="${seconds(layer.timing.enter)}" data-duration="${seconds(layer.timing.end) - seconds(layer.timing.enter)}" data-track-index="${i}" style="${style}"></div>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <style>
${fontFaces(pack)}
:root { ${declarations(rootCss)} }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: var(--palette-bg); }
#root { position: relative; width: 100%; height: 100%; background: var(--palette-bg); }
.cw-layer { position: absolute; }
    </style>
    <script src="runtime.js"></script>
  </head>
  <body>
    <div id="root" data-composition-id="${escapeAttr(compositionId)}" data-start="0" data-duration="${seconds(frames)}" data-width="${width}" data-height="${height}" data-fps="${rate}" data-no-timeline>
${clips}
    </div>
    <script>window.cinewright.mount(${JSON.stringify(spec).replace(/</g, "\\u003c")});</script>
  </body>
</html>
`;
  writeFileSync(join(outDir, "index.html"), html);
}
