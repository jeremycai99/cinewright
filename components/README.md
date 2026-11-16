# @cinewright/components

The core component library (M2.4). Agents choose components from this catalog by id and emit typed IR (D31): a layer names a component, sets its props, and is timed against narration anchors. Components read tokens only (`AGENTS.md` §2.2). The literal lint (`test/no-literals.test.ts`) fails any colour, font, easing, duration or length literal in `src/`.

`cinewright components [<id>]` prints the catalog, and each component's props and the template regions it fits.

## A component

Each folder in `src/` holding a `component.json` is one component:

| File | Holds |
| --- | --- |
| `component.json` | The catalog entry (`core/schema/pack/catalog.schema.json`): `id` (the folder name), `version`, `name`, `runtime` (`waapi` for every core component; a `gsap` component must state its `license`), `catalog` (`summary`, `use_when`, `avoid_when`), `tokens` (every vocabulary path it reads), `templates` (the template regions it fills). |
| `props.schema.json` | The layer props, in the M1 JSON Schema dialect. Props carry content only. A design-valued prop declares `x-token-type` and accepts only `{ "token": <path> }`. |
| `examples.json` | Specimen inputs (`core/schema/pack/examples.schema.json`): template, region, duration, props and optional layer overrides. They hold no pack values, so the same examples render under any pack. |
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
3. **Overflow:** if even that overflows, the element is marked `data-cw-overflow` and the specimen check fails. Text is never clipped silently.

## Catalog

| Component | Use when | Fits |
| --- | --- | --- |
| `kinetic_title` | A short statement: an opening title, a chapter heading, a key claim. Reveals whole, by line or by word (`motion.text_reveal`); optional subtitle and accented words. | `title.title`, `title_body.title`, `full.main`, `end_card.main` |

## Limitations

- **Scripts:** the first-party packs ship Latin fonts. Other scripts fall back to the render image's Noto fonts, which cover Arabic and other non-Latin scripts. CJK needs a pinned CJK font, which no pack ships yet.
