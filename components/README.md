# @cinewright/components

The core component library (M2.4). Agents choose components from this catalog by id and emit typed IR (D31): a layer names a component, sets its props, and is timed against narration anchors. Components read tokens only (`AGENTS.md` §2.2). The literal lint (`test/no-literals.test.ts`) fails any colour, font, easing, duration or length literal in `src/`.

`cinewright components [<id>]` prints the catalog, and each component's props and the template regions it fits.

## A component

Each folder in `src/` holding a `component.json` is one component:

| File | Holds |
| --- | --- |
| `component.json` | The catalog entry (`core/schema/pack/catalog.schema.json`): `id` (the folder name), `version`, `name`, `runtime` (`waapi` for every core component; a `gsap` component must state its `license`), `catalog` (`summary`, `use_when`, `avoid_when`), `tokens` (every vocabulary path it reads), `templates` (the template regions it fills). |
| `props.schema.json` | The layer props, in the M1 JSON Schema dialect. Props carry content only. A design-valued prop declares `x-token-type` and accepts only `{ "token": <path> }`. |
| `examples.json` | Specimen inputs (`core/schema/pack/examples.schema.json`): template, region, duration, props, and optional layer overrides and assets. An asset is a file in the component folder, or `{ file, lavfi }`: a clip the specimen checker generates with the image's FFmpeg, so no media is committed. Examples hold no pack values, so the same examples render under any pack. |
| `index.ts` | The `Build`: given a `ComponentContext`, it creates its DOM inside `ctx.root` and its paused WAAPI animations. |

Patches are checked against the catalog when they are applied:
- **Unknown component:** `semantic.unknown_component`.
- **Unknown prop:** `props.unknown`.
- **Bad prop value:** `props.<keyword>`.
- **Reference of the wrong type in a design-valued prop:** `semantic.token_type`.

A missing required prop is checked when the shot compiles (M3.1), because layers are built across several patches.

## The contract

A composition holds one root element per layer, `#cw-<layer id>`, with class `clip`, absolutely positioned at the layer's region box and timed with HyperFrames' `data-start`, `data-duration` and `data-track-index`. Its `style` carries any CSS variables that differ from the composition's `:root`.

The bundle (`bundleRuntime`, esbuild, one IIFE) defines `window.cinewright.mount(spec)`. The `MountSpec` (`src/host/spec.ts`) gives the frame rate, frame size and aspect class, plus for each layer:
- `component`, `box`, and `align` (vertical) and `justify` (horizontal) from the region;
- `props`;
- `css` and `js` from `tokenEmit`: dimensions in px, durations in ms;
- `timing` in frames: the layer appears at `enter`, and is gone at `end`, when its exit animation finishes;
- `motion` entries and a `seed`.

`mount` waits for `document.fonts.ready`, then calls each layer's `Build` with:

| Field | What it is |
| --- | --- |
| `root` | The layer's root element. |
| `props` | The layer's props. |
| `tokens` | A `TokenReader`: `color`, `px`, `ms`, `easing`, `font`, `number`, `bool`, `text`, each taking a vocabulary path. |
| `timing` | `{ enterMs, endMs }`, in composition time. |
| `frameMs` | Converts frames to ms. |
| `motion` | The layer's motion entries. |
| `aspect`, `align`, `justify` | The aspect class and the region's alignment. |
| `random` | A seeded mulberry32 generator. |
| `captions` | The delivery profile's caption rules. |

Animations are created with `delay` in composition time and paused; HyperFrames seeks them. A layer's entrance uses `fill: "both"` so it holds its start state before it begins. Its exit uses `fill: "forwards"` so it does not cover the entrance.

**Readiness (checked against HyperFrames 0.9.41).** `mount` stores its promise in `window.__hf.buildReady.cinewright`. HyperFrames holds capture until it settles, and fails the render if it rejects, so a layer that cannot build never renders blank. A composition with no GSAP timeline carries `data-no-timeline` on its root; without it, HyperFrames would wait for a timeline to register. The WAAPI spike (Task 5) rendered the `kinetic_title` specimen twice in the pinned image: identical `framemd5` and identical bytes, with no wait for a timeline. The composition's background is painted on the composition root (`#root`), which is what HyperFrames captures.

### Motion

The presets are `fade`, `rise`, `slide`, `scale`, `wipe` and `pop` (`src/motion/presets.ts`):
- **Tokens:** they read `motion.distance` and the `motion.ease.*` tokens; `pop` uses `motion.ease.emphasis`.
- **Disabled presets:** a preset the pack disables (`motion.preset.<name>.enabled: false`) is refused, and the layer fails to build.
- **Layer motion entries:** each is `{ preset, params? }`. `params.phase` is `enter` (the default) or `exit`, and `params.duration` is in frames. Without an entry, the pack's `motion.entrance` and `motion.exit` apply.
- **Short layers:** when a layer is shorter than its entrance plus its exit, `scaleMotion` shrinks both in proportion so they never overlap.

### Text fitting

`fitText` tries the type-scale steps a component allows, largest first:
1. **Whole words:** it keeps the largest step at which the text fits with words whole, within the box and the pack's line limit.
2. **Broken words:** only when no step fits whole words does it let words break, at the smallest allowed step. It never goes below `density.min_text_size`.
3. **Overflow:** if even that overflows, the element is marked `data-cw-overflow`. Text is never clipped silently.

**Markers fail the check.** Once every layer has built, the host logs one console warning per marked element: `cinewright.overflow` or `cinewright.density`, with the layer id and the element. HyperFrames' check reports console warnings, and `render-job check` fails on them under their marker's name (M2.5b).

## Specimens

A specimen is one HyperFrames composition holding every chosen example in turn, under one pack and one delivery profile. It has no pack values outside the emitted tokens, so switching the pack is the only change between two packs' specimens. A pack's example frames are its specimens.

```bash
pnpm --filter @cinewright/components specimens -- --out out/specimens [--pack <id>] [--profile <name>] [--component <id>] [--examples <file>]
uv run cinewright-check-specimens --image cinewright-render:dev out/specimens
```

**Building.** The first command writes `out/specimens/<pack>/<profile>/` for every pack and every profile whose aspect class that pack supports. Each folder holds `index.html`, `runtime.js`, `fonts/` and `samples.json`: the frame rate, the times to check (each example's entrance midpoint, hold midpoint and last frame) and each layer's frames. The profiles are the registry's delivery profiles (`registry/profiles/`); `--profile` takes a name or a path.

**Checking.** The second command:
1. runs `render-job check` on each folder at its sample times;
2. renders it to MP4 and tiles the sample frames into `contact-sheet.png`; before either step, it generates any clip listed in the folder's `generated.json`;
3. writes `summary.json`;
4. fails if any check fails.

A specimen fails on any lint, runtime, layout or contrast error or warning, including text overflowing its box and a component marker (`cinewright.overflow`, `cinewright.density`). A root with no specimens fails too, so CI can never pass having checked nothing. The `specimens` CI job (`render-smoke.yml`) runs both commands on every change to `packs/`, `components/` or the pack format, and uploads the folder, contact sheets included, for the reviewer.

## Catalog

| Component | Use when | Fits |
| --- | --- | --- |
| `kinetic_title` | A short statement: an opening title, a chapter heading, a key claim. Reveals whole, by line or by word (`motion.text_reveal`); optional subtitle and accented words. | `title.title`, `title_body.title`, `full.main`, `end_card.main` |
| `bullet_reveal` | A few parallel points revealed one at a time (`motion.stagger`), with an optional heading. More items or words than the pack's density limits are marked `data-cw-density="exceeded"`. | `title_body.body`, `full.main`, `split.a`, `split.b`, `lower_third.main` |
| `end_card` | The closing shot: headline, optional supporting line, call to action (on-accent on accent) and logo. The logo is an asset, passed in the mount spec's `assets`. | `end_card.main`, `full.main` |
| `caption_track` | Burned-in captions (D35). Each cue shows for exactly its frames, broken into lines at the profile's `max_chars_per_line`. A cue is held for at least `min_display_frames`; one that needs more than `max_lines` lines is marked overflow. Captions are drawn as ink on surface. | `captions.captions` |
| `lower_third` | A name strap: name, optional role, accent bar on a surface panel. | `lower_third.lower_third` |
| `chart` | Bars (compare) or lines (trend), up to six series in `palette.data.1`–`6` order (the props schema rejects a seventh), category labels, value labels on bars, and a legend for more than one series. Bars grow and lines draw on, staggered by series; the largest value fills the plot height. | `title_body.body`, `full.main`, `split.a`, `split.b` |
| `quote_card` | A pull quote with an accent quotation mark and an optional attribution. | `full.main`, `title.title`, `split.a`, `split.b`, `title_body.body` |
| `plate` | An image or video asset, `cover` or `contain`, with an optional Ken Burns push to `camera.ken_burns.scale` toward a focus point. A video is a HyperFrames clip (`class="clip"`, timed to the layer) so it is seeked frame by frame; the push moves a wrapper, never the video. | `full.main`, `split.a`, `split.b`, `title_body.body`, `lower_third.main` |

## Limitations

- **Right-to-left text:** every text element sets `dir="auto"`, so Arabic and Hebrew align to the start side, with list markers before the text. The `bullet_reveal` specimen includes Arabic.

- **Scripts:** the first-party packs ship Latin fonts. Other scripts fall back to the render image's Noto fonts, which cover Arabic and other non-Latin scripts. CJK needs a pinned CJK font, which no pack ships yet.
