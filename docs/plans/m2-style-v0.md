# M2 — Style system v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Style as data. M2 delivers:
- a pack format with a fixed core token vocabulary, layout templates and cited rules;
- the neutral default pack and one contrasting pack;
- the component library v0, whose components read tokens only.

Every component is checked in the pinned container in both aspect classes and under both packs.

**Architecture:**
- **Core (`@cinewright/core`) owns the formats:**
  - the token vocabulary, pack, layout and catalog schemas;
  - the pack loader;
  - region geometry;
  - patch-time checks of token paths, templates and components in the IR.

  These checks don't depend on which pack a project uses, so a bad name fails at `cinewright patch` time, as the M1.9 trial asked.
- **Packs** are plain data in `packs/<id>/`.
- **Components** live in `@cinewright/components` (`components/`). Each has a catalog entry, a props schema and a browser implementation that animates with the Web Animations API (WAAPI).
- **Bundling:** esbuild bundles every component, plus a small host runtime, into one browser script.
- **Specimens:** a specimen builder turns each component's examples into HyperFrames compositions. The container's new `render-job check` mode runs HyperFrames' own `check` (layout, contrast, runtime errors) and takes still frames.

**Tech Stack:** As M1, plus esbuild 0.28.2 (or the version already in `pnpm-lock.yaml`, to avoid a duplicate). Fonts are copied from `@fontsource-variable/inter` 5.3.0 and `@fontsource-variable/fredoka` 5.3.0 (OFL-1.1). HyperFrames stays at 0.9.41, as pinned in M0.2.

**Spec:** `docs/V0_1_PLAN.md` §M2 (M2.1–M2.4 and their shared AC) and Open issue 6. Also:
- `docs/DESIGN_SPEC.md`: "Style system and creative freedom", and decisions D10, D14, D28, D31, D33, D34, D35 and D39;
- `AGENTS.md` §2 (neutrality) and §5 (quality bar), and invariants 3 and 12.

## Decisions this plan makes

Versions were read from npm and the HyperFrames repository on 2026-11-15.

**Approved 2026-11-15** for native execution in the maintainer's Claude Code session, including the WAAPI decision (Open issue 6).

| Choice | Value | Why |
| --- | --- | --- |
| **Animation runtime for core components (resolves Open issue 6; needs approval)** | WAAPI (`element.animate(…, { fill: "both" })`, paused, timed with `delay`). Core components never import GSAP. A user-authored composition (freedom level 5) or an opt-in component may use GSAP; such a component declares `runtime: "gsap"` and the GSAP licence in `component.json`. Whether the image keeps vendoring GSAP for those cases is decided in M3.1, when raw compositions arrive. | HyperFrames 0.9.41 seeks WAAPI and CSS animations natively (`packages/core/src/runtime/adapters/waapi.ts` at tag v0.9.41). WAAPI is a web standard, so core keeps no source-available dependency. GSAP's licence bars tools that compete with Webflow's visual builders. **Cost if wrong:** some effects (SplitText, motion paths) take more component code. **Exit:** if the Task 5 spike shows WAAPI renders are not deterministic, stop and ask. |
| Token tree | M1's plain tree. A leaf is a literal, a `{ "token": path }` reference, or (in packs only) `{ "by_aspect": { <aspect class>: literal or ref } }`. The W3C design-token format (DTCG) is not adopted; an exporter can come later. | M1's cascade resolver and the IR's `token_value` already use this tree, so changing it would touch M1 for no v0.1 gain. |
| Core token vocabulary | One schema, `core/schema/pack/tokens.schema.json`, lists every core token path with its type (annotation `x-token-type`). Every pack defines every core token. `ext.*` is free-form for pack-specific components. Any other unknown path is an error. | Components and agents rely on a fixed set of names, which is how "switch packs with no code change" (D39) can hold. A typo such as `palete.accent` fails instead of being silently ignored. |
| Token types | `color` `#RRGGBB` or `#RRGGBBAA`, uppercase hex · `dimension`: a number ≥ 0, in percent of the frame's shorter side · `duration`: whole milliseconds ≥ 0 · `easing`: `cubic-bezier(x1, y1, x2, y2)` with x1 and x2 in [0, 1], or `linear` · `font_family`: a family declared in the pack's `fonts` · `font_weight`: 100–900 in steps of 100 · `number`, `integer`, `boolean`, `string`, `enum` (schema `enum`), each with optional `minimum`/`maximum` | Sizing relative to the shorter side gives the same pixel size in 1920×1080 and 1080×1920 (D28). Milliseconds keep packs independent of frame rate. |
| Type checks | A pack's references are checked by the type of the path they point to, without resolving them: `type.size.body: { token: "palette.ink" }` fails with `pack.token_type`. A resolved value is checked against its path's type and bounds. IR overrides and references are checked the same way when a patch is applied (see "IR checks"). | Errors come early, and a reference is never type-checked against one pack only. |
| Aspect variants | Only pack tokens may hold `by_aspect`, and the map must cover every aspect class in the pack's `aspect_classes`. IR overrides apply to every aspect class in v0. `resolveEntity` picks the variant for the deliverable. | Per-aspect differences in the IR already go through `layout` maps (D28). An aspect-specific override can come later without changing the format. |
| Emitting tokens | `tokenEmit(resolved, profile)` turns resolved tokens into CSS custom properties and a JS object. A dimension becomes px (percent × shorter side / 100, rounded to 0.01). A duration becomes `<n>ms` in CSS and a number of ms in JS. A font family becomes a quoted name plus a generic fallback. The variable name is the path with `.` replaced by `-` (`palette.data.1` → `--palette-data-1`); token segments contain no `-`, so the mapping is one-to-one. | Components never convert units, so a component has no reason to contain a literal. |
| IR checks at patch time | Added to `validateProject`, independent of the pack: every override path and every `{ token }` reference must be a vocabulary path (`semantic.unknown_token`), and a literal or reference must match the path's type (`semantic.token_type`). A shot template must be a core template or `ext_*` (`semantic.unknown_template`), and a layer region must belong to its shot's template (`semantic.unknown_region`). When the store is given a catalog: a layer's component must be in the catalog (`semantic.unknown_component`), and each present prop must be a known prop with a valid value (`props.unknown`, `props.<schema keyword>`). A missing required prop is checked at compile time (M3.1), not at patch time. | Layers are built across several patches, as M1's always-present wrappers assume. |
| Pack location and id | First-party packs live in `packs/<id>/`. The search path is the project's `packs/`, then the first-party folder. A pack id matches the M1 id pattern. | AGENTS.md §2.1 puts taste in `packs/`. |
| Pack files | `pack.json` (manifest), `tokens.json`, `layouts.json`, `rules.md`, `fonts/` (font files and `OFL.txt`), `README.md` | These are the spec's "tokens JSON + rules Markdown + example frames". Layouts are structured, so they get their own schema rather than being forced into token leaves. |
| Example frames | A pack's example frames are its specimen stills: every component example rendered under that pack. They are made on demand (`pnpm specimens`) and uploaded as a CI artifact. They are never committed. | Rendered stills are generated media (AGENTS.md §6). |
| `pack.json` | `schema_version` (const `1`), `id`, `name`, `version` (semver), `description`, `license`, `aspect_classes` (non-empty subset of the M1 enum), `fonts` (`[{ family, file, weight: [min, max], style, sha256, license, source }]`), `retired_rules` (list of rule ids). `extends` is reserved: present means rejected, with "pack composition comes after v0.1". | The spec's brand-over-genre composition is not needed by the two v0.1 packs. |
| Rules format | Each rule is a level-3 heading ``### `<rule id>` <title>`` followed by its prose, up to the next heading. A rule id matches `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$` and is unique in the pack. Level-2 headings group rules by domain. A citation is `pack:<pack id>@<version>#<rule id>`. | Agents cite rules in decision-log entries (M2.1). The heading form reads well as Markdown and parses with one regex. |
| Rule id stability | A removed id moves to `retired_rules`, and the loader rejects an id that is both live and retired. Each first-party pack has a snapshot test of its rule ids, so removing one shows up as a reviewed diff. | Old decision-log citations must still resolve to a known (if retired) rule. |
| Pack hash | `sha256:` of the JCS form of `{ path: sha256 of file }` over every file in the pack directory. `Pack.hash` is exposed for render keys (M3.2). The project does not pin it in M2. | Resolved token values and font hashes already change render keys. **Cost if wrong:** a plain `pack_hash` field in the project, added like convention 16. |
| Fonts | Each font is a woff2 in the pack's `fonts/` folder, copied once from its Fontsource npm package at a pinned version. Its `sha256`, source (package@version and path) and licence are recorded in `pack.json`, and the OFL text is committed next to it. The loader checks every hash. Compositions load fonts from pack files only; the image's fonts serve only as the generic fallback. | Renders must not depend on what is installed on the machine (D33). Font files are licensed source assets, not generated media. |
| Pack fonts | Neutral: Inter (variable). Playful: Fredoka (variable). | Taste, so it lives in the packs. Inter is designed for screens and widely used as a neutral face; Fredoka's rounded forms are clearly playful (D14). |
| Layout templates | The core templates and their regions, which every pack must define for each of its aspect classes: `full {main}`, `title {title, subtitle}`, `title_body {title, body}`, `split {a, b}`, `lower_third {main, lower_third}`, `end_card {main, footer}`, `captions {captions}`. A template defines the same region names in every aspect class. Pack-specific templates are named `ext_<name>`. A region is `{ col, row, col_span, row_span, align, justify }` in grid cells (1-based); `align` and `justify` are each `start`, `center` or `end`. | The IR names templates and regions, so these names must be the same in every pack for the same IR to render under either pack (D39). |
| Region geometry | The safe rect insets each side by the larger of the profile's title-safe zone (fraction of width or height) and `layout.margin`. The grid has `layout.columns` × `layout.rows` cells with `layout.gutter`, all per aspect class. A region's box spans its cells. Each edge is rounded to the nearest whole pixel, ties up, and width and height come from the rounded edges. | Delivery profiles own platform safe zones (M1); the pack can only add margin. Whole-pixel edges keep text crisp and the output deterministic. |
| Component format | `components/src/<id>/`: `component.json` (`id`, `version`, `name`, `runtime: "waapi"`, `catalog: { summary, use_when, avoid_when }`, `tokens` (vocabulary paths it reads), `templates` (regions it fits)), `props.schema.json` (M1 dialect), `index.ts` (registers a `Build`), `examples.json`. Props carry content only. A design-valued prop must be declared with `x-token-type` and accepts only `{ token }` references (props lint). | Agents choose from the catalog (D31). Content-only props mean an agent cannot put a hex colour in the IR. |
| Component runtime | The host bundle defines `window.cinewright.mount(spec)`. For each layer it places a root element at the layer's region box and calls the component's `Build` with a context (Interfaces, Task 5). Every build waits for `document.fonts.ready`, creates its DOM and animations, and is announced to HyperFrames as ready before the first capture. Task 5 checks the exact readiness hook in 0.9.41. | One bootstrap path for specimens now and the M3.1 compiler later. |
| Motion presets | `components/src/motion/`: `fade`, `rise`, `slide`, `scale`, `wipe`, `pop`. Each reads `motion.*` tokens. A layer's `motion` params (durations in frames, M1) override the defaults. A preset whose `motion.preset.<name>.enabled` token is false is refused (`motion.preset_disabled`, raised by the host). When a layer is shorter than its entrance plus its exit, both are scaled down in proportion and never overlap. | This is the spec's motion grammar: an entrance and exit vocabulary plus "never" rules. |
| Text fitting | A component tries the type-scale steps it allows, largest first, and stops at the first that fits its box within the pack's density limits. It never goes below `density.min_text_size`. If the text still doesn't fit, the component keeps that size and marks the element `data-cw-overflow`, so the check reports it. It never clips silently. | AGENTS.md §5 calls for a minimum on-screen text size, and it does not allow hidden overflow. |
| Seeded randomness | `ctx.random()` is mulberry32, seeded from the first 32 bits of the SHA-256 of the layer id. | Determinism (D33). |
| Literal lint | `components/test/no-literals.test.ts` scans `components/src/**/*.{ts,css}` with comments stripped. It fails on:<ul><li>colour literals: `#hex`, `rgb[a]()`, `hsl[a]()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, and the CSS named colours. `transparent`, `currentColor` and `inherit` are allowed.</li><li>`font-family` or `fontFamily` values that aren't `var(…)` or a token read;</li><li>`cubic-bezier(`, `steps(`, `linear(`, and the easing keywords when used as an easing;</li><li>CSS time literals other than `0s`;</li><li>numbers other than 0 assigned to `duration`, `delay` or `endDelay`;</li><li>length literals other than 0 (`px`, `rem`, `em`, `pt`, `vh`, `vw`, `vmin`, `vmax`). `%` is allowed.</li></ul>A line ending in `/* cw-allow-literal: <reason> */` is exempt; the reason must be non-empty, and every exemption is listed in the test output. | This is M2's AC lint. A test runs in `pnpm test` on every PR. TypeScript 7's compiler API is not stable, so a tokenizer-and-regex scan is used, proven by bad and good fixtures. |
| Bundle | esbuild bundles `components/src/runtime.ts` into `components/dist/runtime.js` as an IIFE with no minification, no sourcemap and target `chrome120`. Two builds must be byte-identical (test). | One script per composition. It works whether HyperFrames serves files over HTTP or not. |
| Render check | `render-job check --in <dir> --out <dir> --at <seconds,…>` runs HyperFrames 0.9.41's `check --json --no-craft --at …` with the network off. It writes `check.json` and still frames at the same times. It exits 0 only if the report's `ok` is true. On the host, `uv run cinewright-check-in-container` mirrors `cinewright-render-in-container`. | HyperFrames' check covers layout overflow and clipping, WCAG AA contrast, runtime console errors and failed requests, so a second checker isn't needed. Craft warnings (dead stretches, unread lines) depend on the film, not the component. |
| "Renders correctly" (M2 AC) | For every component example × pack × aspect class: the check is `ok` at the midpoint of the entrance and of the hold; the stills go into a contact sheet the PR reviewer opens; and no element carries `data-cw-overflow`. Geometry critics proper are M6.1. | These are the measurable parts of "correct". The contact sheet covers the rest by eye. |
| "Same IR under either pack" (M2 AC) | Proven here at component level: specimen inputs (component, props, timing, template, region) contain no pack data, and switching the pack id is the only change between the two specimen runs. M3.1's AC and the alpha gate prove it on a full IR. | The shot compiler that turns an IR into a composition is M3.1. |
| Not in the v0 vocabulary | Texture (grain, halation), brand (logo lockups), generative prompt fragments, camera language beyond Ken Burns | No v0.1 component or job reads them. Each arrives with its first consumer, and adding a vocabulary path is a non-breaking schema change. |

### Core token vocabulary

| Group | Paths (type) |
| --- | --- |
| `palette` | `bg`, `surface`, `ink`, `ink_muted`, `accent`, `on_accent`, `line`, `data.1`–`data.6` (color) |
| `contrast` | `text_min` (number ≥ 4.5), `large_text_min` (≥ 3), `graphic_min` (≥ 3). Packs may raise these WCAG AA floors, never lower them. |
| `type` | `family.display`, `family.body` (font_family) · `weight.regular`, `weight.bold`, `weight.display` (font_weight) · `size.caption`, `size.small`, `size.body`, `size.subtitle`, `size.title`, `size.display` (dimension) · `leading.tight`, `leading.normal` (number) · `tracking.display`, `tracking.body` (number, em) · `transform.display` (enum `none`, `uppercase`) |
| `layout` | `margin`, `gutter` (dimension) · `columns`, `rows` (integer ≥ 1) · `radius`, `stroke` (dimension) |
| `density` | `max_lines_title`, `max_bullets`, `max_words_bullet` (integer) · `min_text_size` (dimension) · `hold_per_word`, `min_hold` (duration) |
| `motion` | `ease.standard`, `ease.enter`, `ease.exit`, `ease.emphasis` (easing) · `duration.xs`, `duration.s`, `duration.m`, `duration.l`, `duration.xl` (duration) · `stagger` (duration) · `distance` (dimension) · `entrance`, `exit` (enum of preset names) · `text_reveal` (enum `whole`, `lines`, `words`) · `preset.<fade, rise, slide, scale, wipe, pop>.enabled` (boolean) |
| `camera` | `ken_burns.scale` (number ≥ 1) · `ken_burns.ease` (easing) |
| `transition` | `default` (enum `cut`, `cross_dissolve`, `wipe`) · `cross_dissolve.enabled`, `wipe.enabled` (boolean) · `cross_dissolve.duration`, `wipe.duration` (duration) · `wipe.direction` (enum `left`, `right`, `up`, `down`) · `wipe.softness` (number 0–1) |
| `sound` | `music.genre`, `music.mood`, `sfx.family` (string) · `music.bpm_min`, `music.bpm_max` (integer) · `sfx.enabled` (boolean) · `duck.depth_db`, `bus.music_db`, `bus.sfx_db` (number ≤ 0) · `duck.attack`, `duck.release` (duration). Loudness targets stay in delivery profiles. |
| `ext` | Free-form; pack-specific |

Components may draw text and graphics only on these pairs, and the pack checks verify each one (`contrastPairs()` in core):

| Kind | Pairs | Minimum ratio |
| --- | --- | --- |
| Text | `ink` on `bg`, `ink` on `surface`, `ink_muted` on `bg`, `ink_muted` on `surface`, `on_accent` on `accent` | `contrast.text_min` |
| Large text | `accent` on `bg` | `contrast.large_text_min` |
| Graphics | `data.1`–`data.6` on `bg` and on `surface`, `line` on `bg` | `contrast.graphic_min` |

## Global Constraints

- **Neutrality** (AGENTS.md §2.2): no colour, font, easing, duration, size or voice literal in `core/` or `components/`. Taste lives only in `packs/<id>/`. A test fixture may hold literals; component sources may not (the literal lint).
- **Neutrality test item 4** (benchmark validation) does not apply until the alpha gate; each PR says so.
- **M1 conventions 1–16 still bind.** The pack, token, layout, catalog and props schemas follow the M1 JSON Schema dialect: no `if`/`then`/`else`, `prefixItems`, `dependent*`, `unevaluated*` or `format`; `oneOf` only with a `const` discriminator; snake_case property names.
- **IR writes:** only `@cinewright/core` writes the IR. Packs and the catalog are read-only inputs. IR fixtures are built through `cinewright patch`.
- **Renders:** run only in the pinned container with the network off. No CDN and no remote fonts; nothing is loaded from outside the composition folder.
- **Core components:** animate with WAAPI only, and never read the wall clock or `Math.random` (D33, HyperFrames determinism rules).
- **Dependencies:** pinned exactly and installed frozen. A version newer than `minimumReleaseAge` gets an exact exclusion, noted in the PR, as M0.2 did.
- **Media:** no generated media in git. Font files and their OFL licence text are allowed in `packs/<id>/fonts/`.
- **Git:** commits end with the harness's `Co-Authored-By` trailer. Pushing, opening PRs and merging each need the maintainer's go-ahead.

## Review Focus

1. **A long unbreakable word in a portrait title** (a 40-character compound word or a URL). The text wraps anywhere at the minimum size, and if it still doesn't fit, the element is marked and the check fails. Nothing is clipped silently. Test: a `kinetic_title` example in Task 5, run as a specimen in Task 6.
2. **Right-to-left text** (an Arabic title and bullets). It renders right-aligned through `dir="auto"`, with its punctuation in place, using the image's Noto fallback, and text fitting measures it correctly. Test: examples in Task 7. CJK has no pinned font yet; Task 7 records that as a known limitation in `components/README.md`.
3. **An override that breaks contrast** (a layer sets `palette.ink` close to `palette.bg`). It resolves without error, and the container check fails with a contrast finding that names the element. Test: a specimen case in Task 6.
4. **A deliverable whose aspect class the pack lacks** (a square profile with a landscape/portrait pack). Resolving or computing geometry fails with `pack.aspect_unsupported`, naming the pack and the aspect class, never with a crash or a fallback. Test in Task 2.
5. **A layer shorter than its entrance plus its exit** (300 ms on screen). The entrance and exit shrink in proportion, never overlap, and the layer ends in its exit state. Test: unit tests of the motion scaling in Task 5 and a specimen case in Task 6.

---

## File structure

```
core/
  schema/pack/                       # pack formats; $id https://cinewright.invalid/pack/0/<name>
    tokens.schema.json  pack.schema.json  layouts.schema.json
    catalog.schema.json  examples.schema.json
    README.md                        # vocabulary table, rules format, error codes
  src/pack/
    vocabulary.ts                    # path → type, from tokens.schema.json
    load.ts                          # loadPack(id, searchPath): Pack
    tokens.ts                        # type checks, by_aspect, contrastPairs, tokenEmit
    rules.ts                         # rules.md parser
    layouts.ts                       # core templates, regionBox
  src/catalog/catalog.ts             # loadCatalog(dir), catalogErrors(ir, catalog)
  src/cascade/resolve.ts             # by_aspect leaves (modified)
  src/ir/semantic.ts                 # token, template, region checks (modified)
  test/fixtures/packs/<case>/…       # valid and broken packs
packs/
  neutral/  playful/                 # pack.json tokens.json layouts.json rules.md fonts/ README.md
  test/packs.test.ts                 # shared pack checks, run over every first-party pack
components/                          # @cinewright/components
  src/runtime.ts                     # host: mount(spec), registry
  src/host/{context,fit,random}.ts
  src/motion/{presets,scale}.ts
  src/<component id>/{component.json,props.schema.json,index.ts,examples.json}
  scripts/{build.mjs,specimens.ts}
  test/{no-literals,catalog,bundle,motion,fit,specimen}.test.ts
  test/fixtures/{literals,specimen}/…
  README.md                          # contract, catalog, limitations
container/render-runner/src/check.ts # render-job check
tools/src/cinewright_tools/container.py   # check_in_container (+ CLI entry)
cli/src/commands/{schema,components}.ts   # `schema tokens`, `components`
```

**Pack error shape:** `{ pack, file, pointer, rule }`, sorted by those fields in that order. The rules:

| Area | Rules |
| --- | --- |
| Schema | `pack.schema.<keyword>` |
| Tokens | `pack.token_type`, `pack.token_bounds`, `pack.unresolved_token`, `pack.token_cycle`, `pack.aspect_missing`, `pack.aspect_unsupported` |
| Fonts | `pack.unknown_font`, `pack.font_hash` |
| Rules | `pack.rule_id`, `pack.rule_duplicate`, `pack.rule_retired` |
| Templates | `pack.template_missing`, `pack.region_mismatch`, `pack.region_bounds` |
| Manifest | `pack.extends_reserved` |

`PackError` carries the list.

---

## Task 1: Token vocabulary, pack format, loader and IR token checks (PR M2.1a)

**Files:**
- Create: `core/schema/pack/{tokens,pack}.schema.json`, `core/schema/pack/README.md`, `core/src/pack/{vocabulary,load,tokens,rules}.ts`, `core/test/pack.test.ts`, `core/test/fixtures/packs/{minimal,bad-ref-type,cycle,aspect-missing,font-hash,rule-dup,rule-retired,extends}/…`
- Modify: `core/src/cascade/resolve.ts`, `core/src/ir/semantic.ts`, `core/src/index.ts`, `core/scripts/gen-types.mjs` (also emits `src/generated/pack.ts`), `cli/src/commands/schema.ts` (`schema tokens`), `cli/README.md`, `cli/test/fixtures/m1-reference/patches/05-shots.json` and the rebuilt `project/` and goldens
- Test: `core/test/{pack,cascade,semantic}.test.ts`, `cli/test/schema.test.ts`

**Interfaces:**
- Consumes: `resolveEntity`, `TokenTree`, `Origin` (M1.3); `validateProject` (M1.1c); the M1 id pattern.
- Produces:
  - `type TokenType = "color" | "dimension" | "duration" | "easing" | "font_family" | "font_weight" | "number" | "integer" | "boolean" | "string" | "enum"`;
  - `vocabulary(): ReadonlyMap<string, { type: TokenType; enum?: string[]; minimum?: number; maximum?: number }>`;
  - `isVocabularyPath(path): boolean` (true for `ext.*`);
  - `interface Pack { id; version; dir; hash: string; manifest: PackManifest; tokens: TokenTree; rules: Rule[]; layouts: Layouts; fonts: PackFont[] }` (layouts are filled in Task 2);
  - `loadPack(id: string, searchPath: string[]): Pack` (throws `PackError`);
  - `interface Rule { id; title; section; body }`;
  - `citation(pack, ruleId): string`;
  - `checkResolved(tokens: Record<string, ResolvedToken>): ValidationError[]`;
  - `resolveEntity(...)`, which now picks `by_aspect` variants and throws `CascadeError` with `pack.aspect_unsupported` for an aspect class the pack lacks.

- [ ] **Step 1: Write the failing tests.**
  - **`pack.test.ts`:** `minimal` loads, with its hash equal to the value in `expected.json`. Each broken fixture fails with exactly its error list:
    - `bad-ref-type`: `pack.token_type` at `/type/size/body`;
    - `cycle`: `pack.token_cycle`;
    - `aspect-missing`: `pack.aspect_missing`, naming `portrait`;
    - `font-hash`: `pack.font_hash`;
    - `rule-dup`: `pack.rule_duplicate`;
    - `rule-retired`: `pack.rule_retired`;
    - `extends`: `pack.extends_reserved`.

    Also: rules parse to `{ id, title, section, body }`; `citation` gives `pack:minimal@1.0.0#motion.no_bounce`; and a path missing from `tokens.json` gives `pack.schema.required`, naming the path.
  - **`cascade.test.ts`:** a `by_aspect` leaf resolves to each deliverable's variant with origin `pack`; an IR override beats both variants; a square deliverable with a landscape/portrait pack throws `pack.aspect_unsupported`.
  - **`semantic.test.ts`:**
    - an override `palette.acent` → `semantic.unknown_token`;
    - `palette.accent: 12` → `semantic.token_type`;
    - a camera ease `{ token: "palette.ink" }` → `semantic.token_type`;
    - `ext.anything` with any value passes.
  - **`schema.test.ts`:** `cinewright schema tokens` prints every vocabulary path with its type, and `--json` gives the same list as data.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test && pnpm --filter @cinewright/cli test`. Expected: FAIL (no pack module).
- [ ] **Step 3: Implement.**
  - **Schemas:** write `tokens.schema.json` from the vocabulary table. Each leaf is `anyOf` [typed literal, `token_ref`, `by_aspect`] and carries `x-token-type`. `ext` is an open object.
  - **Vocabulary and loader:** derive `vocabulary()` from the schema, never from a hand-kept list. Then write the loader:
    1. validate the schemas with Ajv2020, using M1's options;
    2. check font hashes;
    3. check references by target type;
    4. resolve each aspect class and check types and bounds;
    5. parse the rules;
    6. compute the hash.
  - **Cascade:** extend `flatten` and the resolver so `by_aspect` is a leaf.
  - **Semantic checks:** add the token checks to `validateProject`.
  - **Reference project:** update `05-shots.json` to vocabulary names (`motion.ease_out_expo` → `motion.ease.enter`). Rebuild `project/` and the goldens with `build.sh`, and read the diff.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check && uv run pytest`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): pack format, token vocabulary and patch-time token checks"`.

## Task 2: Layout templates and region geometry (PR M2.1b)

**Files:**
- Create: `core/schema/pack/layouts.schema.json`, `core/src/pack/layouts.ts`, `core/test/layouts.test.ts`, `core/test/fixtures/packs/{template-missing,region-mismatch,region-bounds}/…`
- Modify: `core/src/pack/load.ts`, `core/src/ir/semantic.ts`, `core/test/fixtures/packs/minimal/layouts.json`, `core/schema/pack/README.md`, `cli/test/fixtures/m1-reference/patches/05-shots.json` and the rebuilt `project/` and goldens

**Interfaces:**
- Consumes: `Pack`, `loadPack`, `resolveEntity` (Task 1); `DeliveryProfile` (M1).
- Produces:
  - `CORE_TEMPLATES: Readonly<Record<string, readonly string[]>>` (template → region names);
  - `interface Box { x: number; y: number; width: number; height: number }` (integer px);
  - `regionBox(pack: Pack, template: string, region: string, profile: DeliveryProfile): Box` (throws `PackError` with `pack.aspect_unsupported` or `pack.template_missing`);
  - `safeRect(pack, profile): Box`.

- [ ] **Step 1: Write the failing tests.**
  - **`layouts.test.ts`:** the three broken fixtures fail with exactly their errors.
  - **Hand-computed boxes:** for `minimal`, `regionBox` matches boxes computed by hand in the test, for:
    - 1920×1080 with a 5% title-safe zone and a smaller pack margin (the profile wins);
    - 1080×1920 with a larger pack margin (the pack wins);
    - a 1280×720 profile, to check the rounding.
  - **Grid properties (fast-check, 1,000 runs):** for random grids, margins and profiles, the boxes of adjacent regions never overlap, and every box lies inside the safe rect.
  - **Square deliverable:** a square profile throws `pack.aspect_unsupported`.
  - **`semantic.test.ts`:** a shot template `grid.12col/title-left` → `semantic.unknown_template`; a layer region `left` under `title_body` → `semantic.unknown_region`; `ext_hero` with any region passes.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the loader checks (core templates present for every aspect class, same region names in every variant, regions within each aspect's grid), `safeRect` and `regionBox` as the Decisions table says, and the semantic checks. Update `05-shots.json` to core templates (`title_body` with regions `title` and `body`), rebuild the reference and read the diff.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): layout templates and region geometry"`.

## Task 3: Neutral default pack and shared pack checks (PR M2.2)

**Files:**
- Create: `packs/neutral/{pack.json,tokens.json,layouts.json,rules.md,README.md,fonts/InterVariable.woff2,fonts/OFL.txt}`, `packs/package.json` (private workspace package `@cinewright/packs`, test only), `packs/test/packs.test.ts`, `packs/test/__snapshots__/`
- Modify: `pnpm-workspace.yaml`, `core/src/pack/tokens.ts` (`contrastPairs`, `contrastRatio`)

**Interfaces:**
- Consumes: `loadPack`, `regionBox`, `checkResolved` (Tasks 1–2).
- Produces:
  - `contrastRatio(a: string, b: string): number` (WCAG 2.x relative luminance; an alpha colour is composited over the opaque background first);
  - `contrastPairs(tokens): { kind: "text" | "large_text" | "graphic"; fg: string; bg: string; min: number }[]`;
  - `packs/neutral`, which Task 5 onward render with.

- [ ] **Step 1: Write the failing tests** in `packs.test.ts`. They are parameterised over every directory in `packs/` that has a `pack.json`. Each pack:
  - loads with no errors;
  - meets every contrast pair at its minimum;
  - has a strictly increasing `type.size.*` (caption < small < body < subtitle < title < display);
  - has `type.size.caption ≥ density.min_text_size`;
  - has a strictly increasing `motion.duration.*`;
  - uses no `linear` in any `motion.ease.*` (AGENTS.md §5: eased, no linear default);
  - has `motion.entrance` and `motion.exit` naming enabled presets, and an enabled `transition.default`;
  - satisfies `music.bpm_min ≤ music.bpm_max`;
  - matches the snapshot of its rule ids;
  - has, for every font, a `license` of `OFL-1.1` and an `OFL.txt` in its folder.

  Also: `rules.md` has at least one rule per domain (`color`, `type`, `layout`, `density`, `motion`, `transition`, `sound`), and the README names the pack as the neutral default and states what it is for.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/packs test`. Expected: FAIL (no packs).
- [ ] **Step 3: Write the neutral pack.**
  - **Design brief:** restrained and legible (AGENTS.md §2.2). It should be reasonable for a corporate explainer, a children's lesson, a documentary, a product ad and a narrative short:
    - a near-white background with near-black ink and one accent;
    - six data colours that meet 3:1 on both backgrounds;
    - Inter in two weights;
    - a modular type scale;
    - standard and decelerating easing, with no overshoot;
    - `pop` disabled;
    - `cross_dissolve` as the default transition;
    - a music genre "unobtrusive ambient" in a 70–110 BPM range, and −12 dB ducking.
  - **Grid:** 12 × 6 in landscape, 4 × 8 in portrait.
  - **Rules:** in `rules.md`, the craft principles and when each transition applies, each with an id.
  - **Fonts:** copy `InterVariable.woff2` from `@fontsource-variable/inter@5.3.0` (fetched with `pnpm dlx` into the scratch folder, never added as a dependency), and record its sha256, source and licence.
  - **Contrast:** implement `contrastRatio` and `contrastPairs`.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass. Commit the rule-id snapshot.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(packs): neutral default pack and shared pack checks"`.

## Task 4: Contrasting pack, playful (PR M2.3)

**Files:**
- Create: `packs/playful/{pack.json,tokens.json,layouts.json,rules.md,README.md,fonts/Fredoka.woff2,fonts/OFL.txt}`
- Modify: `packs/test/packs.test.ts` (difference test), `packs/test/__snapshots__/`

**Interfaces:**
- Consumes: the shared pack checks (Task 3).
- Produces: `packs/playful`.

- [ ] **Step 1: Write the failing test.** `playful` passes every shared check. A difference test asserts that it differs from `neutral` in each of D39's five domains:
  - type (`type.family.display` differs);
  - palette (at least 4 of the 7 non-data palette roles differ);
  - motion grammar (`motion.ease.enter` differs, and `motion.preset.pop.enabled` is true here and false in neutral);
  - transitions (`transition.default` differs);
  - sound palette (`sound.music.genre` and the BPM range differ).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/packs test`. Expected: FAIL.
- [ ] **Step 3: Write the pack.**
  - **Design brief:** saturated warm and cool colours on a light background, still meeting every contrast pair. Fredoka for display and body.
  - **Motion:** larger radii, an overshoot `ease.emphasis`, and `pop` enabled.
  - **Transitions and sound:** `wipe` as the default transition, upbeat music at 110–140 BPM, and SFX enabled.
  - **Rules:** the rules state when overshoot is appropriate and when it isn't (it is never used on body text).
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(packs): playful contrasting pack"`.

## Task 5: Component contract, host runtime, motion, literal lint and `kinetic_title` (PR M2.4a)

**Files:**
- Create:
  - `components/{package.json,tsconfig.json,README.md}`;
  - `components/src/{runtime.ts,host/context.ts,host/fit.ts,host/random.ts,motion/presets.ts,motion/scale.ts}`;
  - `components/src/kinetic_title/{component.json,props.schema.json,index.ts,examples.json}`;
  - `components/scripts/{build.mjs,specimens.ts}`;
  - `components/test/{no-literals,catalog,bundle,motion,fit,specimen}.test.ts`;
  - `components/test/fixtures/literals/{bad,good}/…`;
  - `core/schema/pack/{catalog,examples}.schema.json`, `core/src/catalog/catalog.ts`;
  - `cli/src/commands/components.ts`.
- Modify:
  - `pnpm-workspace.yaml`;
  - `core/src/pack/tokens.ts` (`tokenEmit`), `core/src/store/store.ts` (`StoreOptions.catalog`);
  - `cli/package.json` (depends on `@cinewright/components` for its catalog folder), `cli/src/project.ts` (opens the store with the first-party catalog), `cli/README.md`;
  - `biome.json` (excludes `components/dist`);
  - `cli/test/fixtures/m1-reference/patches/05-shots.json`, with the rebuilt `project/` and goldens. The `kinetic_title` `color` prop goes, because emphasis comes from `palette.accent`. The `data_bars` layer goes until Task 8 adds `chart`; otherwise the catalog check would reject the reference build.

**Interfaces:**
- Consumes: `loadPack`, `regionBox`, `resolveEntity`, `checkResolved` (Tasks 1–3); `cinewright-render-in-container` (M0.2).
- Produces:
  - **Catalog (core):** `interface CatalogEntry { id; version; runtime: "waapi" | "gsap"; catalog: { summary; use_when; avoid_when }; tokens: string[]; templates: Record<string, string[]>; props: JsonObject }`, `loadCatalog(dir): Catalog`, `catalogErrors(ir, catalog): ValidationError[]` and `StoreOptions.catalog`.
  - **Token emitter (core):** `tokenEmit(resolved, profile): { css: Record<string, string>; js: Record<string, string | number | boolean> }`.
  - **Browser host:** `window.cinewright.mount(spec: MountSpec)` with `MountSpec = { fps: Rational; width: number; height: number; aspect: AspectClass; layers: LayerSpec[] }` and `LayerSpec = { id; component; box: Box; props; css; js; timing: { enter: number; exit: number | null; end: number }; motion: MotionPreset[]; captions?: DeliveryProfile["captions"] }` (frames). `Build = (ctx: ComponentContext) => void | Promise<void>`, where `ComponentContext = { root: HTMLElement; props; tokens: TokenReader; timing; fps; motion; aspect; random: () => number; captions? }` and `TokenReader` has `color`, `px`, `ms`, `easing`, `font`, `number`, `bool`, `text`, each taking a vocabulary path.
  - **Motion:** `scaleMotion(enterMs, exitMs, holdMs): { enter: number; exit: number }`.
  - **Text fitting:** `fitText(el, steps: number[], box, maxLines): { size: number; overflow: boolean }`.
  - **Specimens:** `buildSpecimen(packId, aspect, examples, outDir): { dir: string; samples: number[] }`, which writes a HyperFrames composition (root with `data-composition-id`, `data-width`, `data-height`, `data-fps`; one clip per example; fonts and `runtime.js` copied in; the mount spec inline as JSON).

- [ ] **Step 1: Write the failing tests.**
  - **`no-literals.test.ts`:** every file in `fixtures/literals/bad/` is flagged with the expected category and line, which pins each category in the Decisions table. Every file in `good/` passes. All of `components/src/` passes, and the test prints any `cw-allow-literal` exemptions.
  - **`catalog.test.ts`:**
    - every component folder loads;
    - each props schema compiles under the M1 dialect;
    - each prop with `x-token-type` accepts only `{ token }`;
    - each `tokens` entry is a vocabulary path;
    - each `templates` entry names core regions.

    `catalogErrors` flags an unknown component and an unknown prop, and passes a known prop with a valid value. `cinewright components` lists `kinetic_title` with its summary, and `components kinetic_title --json` prints its entry and props schema.
  - **`motion.test.ts`:** `scaleMotion(400, 400, 300)` gives 150 and 150; long holds are unchanged; and fast-check over random inputs checks that `enter + exit ≤ hold` whenever scaling applies.
  - **`fit.test.ts`:** run `fitText` in Vitest's browser-free mode, with a fake measure function. It picks the largest step that fits, never goes below the minimum, and reports `overflow`.
  - **`bundle.test.ts`:** two builds of `runtime.js` are byte-identical, and the bundle contains no `gsap`.
  - **`specimen.test.ts`:** for `kinetic_title` × {neutral} × {landscape, portrait}, `buildSpecimen` writes a composition whose mount spec matches a golden JSON. The spec holds boxes from `regionBox` and px tokens from `tokenEmit`, and no pack value outside `css` and `js`.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/components test && pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3: Implement** the catalog, `tokenEmit`, the host, the six motion presets, `fitText`, the seeded random, the esbuild build and `kinetic_title`.
  - **`kinetic_title` props:** `text` (required), `subtitle` and `emphasis` (word indices drawn in `palette.accent`).
  - **Its reveal** follows `motion.text_reveal`.
  - **Its examples:** a short title, a two-line title with a subtitle, the long unbreakable word (Review Focus 1), and a 300 ms layer (Review Focus 5).
- [ ] **Step 4: WAAPI determinism spike** (gate for the runtime decision).
  - **Build and render:** build the `kinetic_title` specimen for neutral × landscape, then render it twice as a PNG sequence with `uv run cinewright-render-in-container`.
  - **Expected:**
    - frame 0 shows the pre-entrance state, the entrance midpoint shows partial motion, and the hold shows the final layout;
    - both renders have identical `framemd5`;
    - the render log shows no 45-second wait for timeline registration.
  - **If 0.9.41 waits for a GSAP timeline:** mark the root `data-no-timeline` and repeat.
  - **Readiness:** confirm the hook that holds capture until fonts and builds are done (`window.__hf.buildReady` or 0.9.41's equivalent, read from the tagged source), and record it in `components/README.md`.
  - **If renders differ or motion is missing:** stop and ask the maintainer (runtime decision exit).
- [ ] **Step 5:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check && uv run pytest`. Expected: all pass.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat(components): component contract, host runtime, motion presets and kinetic_title"`.

## Task 6: Specimen checks in the container and CI (PR M2.4b)

**Files:**
- Create: `container/render-runner/src/check.ts`, `container/render-runner/test/check.test.ts`, `tools/tests/test_check.py`
- Modify: `container/render-runner/src/cli.ts` (`check` subcommand, usage, exit codes), `tools/src/cinewright_tools/container.py` and `pyproject.toml` (`cinewright-check-in-container`), `components/scripts/specimens.ts` (`pnpm specimens [--pack] [--aspect] [--component]`, contact sheet), `.github/workflows/render-smoke.yml` (a `specimens` job; triggers add `packs/**`, `components/**`, `core/src/pack/**`), `container/README.md`, `components/README.md`

**Interfaces:**
- Consumes: `buildSpecimen` (Task 5); the image and runner (M0.2).
- Produces:
  - `render-job check --in <dir> --out <dir> --at <s,…>` (exit 0 if ok; 5 if check findings; 2 usage; 3 blocked request);
  - `check_in_container(image, in_dir, out_dir, at) -> CheckResult`;
  - `pnpm specimens`, which writes `out/specimens/<pack>/<aspect>/{check.json, stills/, contact-sheet.png}`.

- [ ] **Step 1: Write the failing tests.**
  - **`check.test.ts`:** argument parsing (missing `--at`, a bad number, an unknown flag); the HyperFrames argument list is exactly `check <dir> --json --no-craft --at <times>`, plus the env that disables telemetry and update checks; the exit code is mapped from `ok`.
  - **`test_check.py`** (container tests, gated by `CINEWRIGHT_CONTAINER_TESTS=1` like M0.2):
    - the `kinetic_title` specimen passes in both packs (neutral, and playful once Task 4 has merged; otherwise neutral only, noted in the PR) × both aspects;
    - a layer override setting `palette.ink` to `palette.bg`'s value fails with a contrast finding naming the title element (Review Focus 3);
    - the long-word example in portrait passes, or fails only with a finding whose element carries `data-cw-overflow`;
    - the 300 ms example passes, and its last frame shows the exit state (Review Focus 5).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/render-runner test` and `CINEWRIGHT_CONTAINER_TESTS=1 uv run pytest tools/tests/test_check.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`check.ts`:** call the HyperFrames CLI inside the image, with the same environment as the render (network off, telemetry off, pinned browser path). Check the flag names against the 0.9.41 source of `packages/cli/src/commands/check.ts`. Stills come from `check --snapshots` at the `--at` times, if 0.9.41 supports that; otherwise use `snapshot --at`. Record which in `container/README.md`.
  - **Contact sheet:** `specimens.ts` makes it with the image's FFmpeg (`tile` filter), run in the container.
  - **CI job:** builds or pulls the image as the smoke job does, runs every specimen and uploads `out/specimens/` as an artifact.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && uv run pytest`, then `CINEWRIGHT_CONTAINER_TESTS=1 uv run pytest tools/tests/test_check.py`. Expected: all pass. Open the contact sheets and check them by eye.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(container): render-job check and component specimens in CI"`. The image's inputs change, so after merge `render-image` publishes, and a follow-up PR updates `image.lock.json`, as in M0.

## Task 7: Alpha components: `bullet_reveal`, `end_card`, `caption_track` (PR M2.4c)

**Files:**
- Create: `components/src/{bullet_reveal,end_card,caption_track}/{component.json,props.schema.json,index.ts,examples.json}`
- Modify: `components/README.md` (catalog table; CJK limitation), `components/test/specimen.test.ts` goldens

**Interfaces:**
- Consumes: the contract, host, motion, fitting and specimen check (Tasks 5–6).
- Produces: three catalog entries.
  - `bullet_reveal { title?, items: string[] (1+) }`: more than `density.max_bullets` items, or more than `max_words_bullet` words, marks overflow; items are staggered by `motion.stagger`.
  - `end_card { headline, subline?, cta?, logo?: asset id }`: an asset is passed as a URL map in the mount spec; the specimen uses an SVG fixture.
  - `caption_track { cues: [{ text, start, end }] }`: frames relative to the layer's enter; wraps at the profile's `max_chars_per_line` and `max_lines`; a cue is shown for at least `min_display_frames`; uses `palette.surface` and `palette.ink`, `type.size.caption` and the `captions` template.

- [ ] **Step 1: Write the failing tests.**
  - **Catalog and goldens:** the catalog test covers the three entries, and the specimen goldens cover them.
  - **`bullet_reveal`:** a unit test checks that the stagger starts match `enter + i × stagger`.
  - **`caption_track`:** a unit test checks the line breaking against the profile's limits, and that a cue shorter than `min_display_frames` is extended.
  - **Container tests:** every example of the three passes in both packs × both aspects, including an Arabic title and bullets (Review Focus 2).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/components test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three components and their examples.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`, then the container tests. Expected: all pass. Check the contact sheets by eye.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(components): bullet_reveal, end_card and caption_track"`.

## Task 8: Beta components: `lower_third`, `chart`, `quote_card`, `plate` (PR M2.4d)

**Files:**
- Create: `components/src/{lower_third,chart,quote_card,plate}/{component.json,props.schema.json,index.ts,examples.json}`
- Modify: `components/scripts/specimens.ts` (generated video fixture), `components/README.md`, `cli/test/fixtures/m1-reference/patches/05-shots.json` (adds back the data layer as a `chart` bar layer, which replaces the spec example's `data_bars`) and the rebuilt `project/` and goldens

**Interfaces:**
- Consumes: as Task 7.
- Produces: four catalog entries.
  - `lower_third { name, role? }`
  - `chart { kind: "bar" | "line", categories: string[], series: [{ label, values: number[] }] (1–6), unit? }`: series colours are `palette.data.1`–`palette.data.6` in order. Bars grow, and lines draw with `stroke-dashoffset`.
  - `quote_card { quote, attribution? }`
  - `plate { asset, fit: "cover" | "contain", ken_burns: boolean, focus?: { x, y } }`: images and video. Ken Burns scales to `camera.ken_burns.scale` with `camera.ken_burns.ease` over the layer.

- [ ] **Step 1: Write the failing tests.**
  - **Catalog and goldens:** catalog entries and specimen goldens for the four components.
  - **`chart`:** a unit test checks that the scaling maps the max value to the box height minus the label band, and that 7 series are rejected by the props schema.
  - **Container tests:** every example passes in both packs × both aspects. The video plate uses a clip generated in the container at check time (`ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30:duration=2`), never committed.
  - **Reference project:** the rebuilt project with the `chart` layer passes the catalog check, and a second rebuild is byte-identical to it.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/components test`. Expected: FAIL.
- [ ] **Step 3: Implement** the four components, their examples and the generated-fixture step, and update the reference patch.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && uv run pytest`, then the container tests. Expected: all pass. Check the contact sheets by eye.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(components): lower_third, chart, quote_card and plate"`.

---

## Done when (M2 AC map)

| M2 requirement or acceptance criterion | Proven by |
| --- | --- |
| M2.1: pack format (tokens JSON, rules Markdown, example frames) and loader; every rule has a stable, citable id | Tasks 1–2 (loader, rules, citations, retired ids); example frames are specimen stills (Task 6) |
| M2.2: neutral pack defining grid, safe areas and templates per aspect class, type scale, motion grammar, transitions and when each applies, density limits, sound palette and ducking; no loudness targets | Task 3 (pack and shared checks); Task 2 (geometry) |
| M2.3: a pack differing in type, palette, motion grammar, transitions and sound palette | Task 4 (difference test) |
| M2.4: alpha and beta component sets, each with a props schema and catalog description, reading tokens only | Tasks 5, 7, 8 (catalog tests) |
| AC: a lint rule fails any component containing literal design values | Task 5 (`no-literals.test.ts` with bad and good fixtures, run in `pnpm test`) |
| AC: every component renders correctly in both aspect ratios and both packs | Tasks 6–8 (container check on every example × pack × aspect, plus contact sheets) |
| AC: the same IR renders under either pack by changing only the style reference | Component level here (Task 6: specimen inputs hold no pack data); full IR at M3.1 and the alpha gate |
| Open issue 6 settled before M2.4 | Decisions table (approval of this plan); Task 5 spike |

## Execution notes

- **PR order:** Task 1 → 2 → 3 → 5 → 6, which is the path to "one IR shot through HyperFrames" in §Suggested order. Then Tasks 4, 7 and 8 in any order. M3 planning can start once Task 6 merges.
- **Generated types:** Task 1 makes `gen:types` emit `core/src/generated/pack.ts` too, and `gen:check` covers it. Python does not read packs in v0.1, so it gets no pack models.
- **Reference project:** each rebuild (Tasks 1, 2 and 8) regenerates `project/` and the goldens with `build.sh`. Read the diff before committing, as in M1.9.
- **Pack fonts:** copied from their packages with `pnpm dlx` into the scratch folder. The plan names each file's source, and approving the plan covers fetching these two packages.
