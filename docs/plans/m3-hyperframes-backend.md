# M3 — HyperFrames backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one shot of the IR into a deterministic render for each deliverable:
- resolve the project's pinned pack;
- compile the shot's typed layers into a HyperFrames composition;
- render it in the pinned container through a backend plugin, cached by a render key that covers everything the output depends on;
- render overlap transitions as their own segments, burned-in captions as a layer, and keyframe stills for critics and the storyboard gate.

**Architecture:**
- **Delivery profiles** become data in `registry/profiles/` (moved from M5.3).
- **The project pins its pack** (id, version, hash) the way it copies its profiles (convention 16).
- **A new Apache-2.0 plugin, `plugins/backend-hyperframes`,** owns the compiler and the renderer adapter. It is the only producer of HTML (D31), and it is the backend plugin the spec's invariant 5 asks for. Its main functions:

  | Function | What it does |
  | --- | --- |
  | `compileShot` | Builds the M2 mount spec from the resolved IR and a timing table, and writes the composition with the components package's composition writer (extracted from the specimen builder). |
  | `renderShot` | Runs `render-job` in the pinned image with run limits, and keeps PNG frames, the encoded body, `framemd5` and logs in a disposable render cache keyed by `renderKey` v1. |

- **Segments:** transitions are blended from the two shots' overlap frames with the pinned FFmpeg.
- **Captions:** a `caption_track` layer the compiler adds when a deliverable burns them in.
- **Keyframes:** stills and text boxes at stated sample frames.

**Tech Stack:**
- As M2, with HyperFrames refreshed in M3.0 to the release current on its execution day (0.9.56 at the audit) and Chrome headless shell pinned from that release's `CHROME_VERSION`.
- No new runtime dependencies beyond what HyperFrames brings; FFmpeg is the one already pinned in the image.

**Spec:**
- `docs/V0_1_PLAN.md`: §M3 and §Revised task breakdown and order (M3.0, M5.3, M3.1a–M3.5).
- `docs/plans/roadmap-audit-2026-11-16.md`: findings F3, F4, F5 and F17, §3.1, and decisions 3–6.
- `docs/DESIGN_SPEC.md`: D10, D27, D28, D31, D33, D34, D35, D37 and D39.
- `AGENTS.md` §3, invariants 5, 7 and 12.

## Decisions this plan makes

The first four rows are the audit's maintainer decisions due for M3. **Approving this plan approves them.**

| Choice | Value | Why |
| --- | --- | --- |
| **HyperFrames bump and policy (audit decision 3)** | M3.0 moves to the current release and re-reads every fact M2 relies on from the tagged source. After that, bump only at a milestone start or for a security fix, and rebase determinism baselines in the same PR. | Nine releases after the pin carry security fixes; HyperFrames ships several times a day. |
| **Remove GSAP from the image (decision 4)** | M3.0 drops GSAP from the image and converts the two smoke fixtures to WAAPI. It returns with user-authored compositions (freedom level 5), with its licence declared. | No v0.1 code uses GSAP, and keeping it vendors source-available code with no consumer. **Cost if wrong:** re-adding one vendored file. |
| **Pin the pack in the project (decision 5)** | `cinewright init --pack <id>` (default `neutral`) writes `style.pack` and a plain `project.packs: { <id>: { version, hash } }`, like `profiles`. `cinewright pack pin <id>` adds or refreshes a pin through the store (a new log entry kind, `pinned`). Compiling fails with `pack.pin_mismatch`, naming both versions, when the pack on disk no longer matches its pin. | A pack update must never silently change an existing project (D33). Convention 16 already does this for profiles. |
| **Transition timing (decision 6)** | An overlap transition of `d` frames is centred on the cut: it starts `h = floor(d / 2)` frames before the cut and ends `d − h` frames after it. **Total length is unchanged.** Each shot is compiled over its span plus the overlap on any side with a segment transition. Exits of layers that end at an outgoing transition are suppressed, because the transition is their exit. The outgoing body stops at the segment's start and the incoming body begins at its end; the segment blends the two shots' frames over the overlap. A cut has no segment. | Matches how editors place transitions, keeps the timing solver's arithmetic simple, and lets each shot be rendered once, with its overlap frames reused by the segment. |
| Where the compiler lives | `plugins/backend-hyperframes` (Apache-2.0), implementing the M1.8 plugin contract with capability `render.composition`. The CLI and the later engine call it through the plugin interface. | Invariant 5: renderers are plugins. Invariant 12: compilers own HTML. |
| Composition writer | The HTML, fonts, bundle and asset copying move out of `components/src/node/specimen.ts` into `components/src/node/composition.ts` (`writeComposition`). Specimens and the compiler both call it. | One path writes compositions, so the M2 fixes (background on the root, `data-no-timeline`, readiness, markers) hold for real shots. |
| Escaping (F5) | One function, `cssValue`, writes every token value into CSS: a value containing `<`, `>`, `{`, `}`, `;` or a backslash is rejected (`compile.unsafe_value`, naming the token and its origin). The pack loader also rejects such string tokens (`pack.token_unsafe`). Attribute styles are HTML-escaped. | A pack or override is data; it must never add markup or rules. |
| Timing table | `TimingTable = { fps, lines: { <line id>: { start, end, words: [{ start, end }] } } }`, in frames on the sequence timeline. Until M4.2 writes it from narration, a fixture or `--timing <file>` supplies it. `resolveAnchor(anchor, table)` gives a frame and fails with `timing.unknown_line` or `timing.unknown_word`. | M2's mount spec needs absolute frames, and the IR holds anchors (convention 15). |
| Shot span | A shot starts at its `anchors.start` frame. It ends at `anchors.end` if set, otherwise after its `duration` field, otherwise at the next shot's start. A shot with none of these is a compile error (`compile.unknown_span`). | Deterministic, and the M4.2 solver later fills the durations. |
| Compile-time checks | Missing required props (`compile.missing_prop`), an unknown template or region for this deliverable's pack (`compile.unknown_region`), and a component that is not in the catalog. Each error names the layer and field. | Patch time skips required props, because layers are built across patches (M2). |
| Render key v1 (F3) | `sha256` of the JCS form of the compiled composition's inputs, with `Pack.hash` deliberately not used, since it covers `README.md`. The inputs:<ul><li>the mount spec;</li><li>the root CSS;</li><li>each font file's sha256;</li><li>the runtime bundle's sha256;</li><li>each asset's hash;</li><li>the compiler version;</li><li>the HyperFrames version;</li><li>the image digest;</li><li>the render settings;</li><li>the profile hash.</li></ul> | It covers everything a frame depends on: tokens read implicitly, region boxes, fonts and component code. |
| Render cache | `.cinewright/cache/renders/<render key>/`: `frames/`, `body.mp4`, `framemd5.txt`, `sha256.txt`, `render-log.jsonl` and `inputs.json`. It is disposable (D37, M1.7); deleting it only costs time. | Renders are derived, not IR assets. |
| Segments | FFmpeg `xfade` with `transition=custom` and an eased progress expression built from `transition.<type>.*` tokens. A wipe uses the token's direction and softness. Frames come from the two shots' cached overlap PNGs; the encode follows the M0.2 settings (`-threads 1`, bitexact). | Deterministic with the pinned FFmpeg, and nothing is re-rendered in the browser. |
| Run limits (F17) | Every container run adds a memory limit, `--pids-limit`, `--cap-drop ALL`, `--security-opt no-new-privileges` and a read-only root with a tmpfs for `/tmp`. Each run has a wall-clock timeout taken from the frame count. | User assets now enter the container. |
| Dev commands | `cinewright compile <shot> --deliverable <id> [--timing <file>] --out <dir>` and `cinewright render-shot <shot> --deliverable <id> [--timing <file>]`. They are documented as developer tools until `cinewright render` (M5.4). | Lets agents and tests drive one shot end to end. |

## Global Constraints

- **Rules from earlier milestones:** the M1 conventions and M2's neutrality rules still bind. No design literal goes in core, components or the backend plugin; taste lives in packs and profiles.
- **Determinism (D33):** two renders of the same compiled composition, in the same image, give identical `framemd5` and identical bytes on one runner class.
- **Renders:** the network is off for every render, as it always has been. Add the run limits above.
- **Dependencies:** pinned exactly and installed frozen.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.
- **Neutrality test item 4:** it doesn't apply until the alpha gate; each PR says so.

## Review Focus

1. **A pack edited after its pin.** Compiling fails with `pack.pin_mismatch`, naming the pinned and found versions, and renders nothing; `cinewright pack pin` recovers. Test: Task 3.
2. **A hostile pack or override value** (`</style><script>`, or `red; } body { display: none`). Loading or compiling fails, naming the token; no markup is written. Test: Task 4.
3. **A transition longer than either adjacent shot's span.** A typed error (`compile.transition_too_long`, naming the scene and both shots), never a negative body length. Test: Task 7.
4. **A layer whose anchor names a word that no longer exists** (the line was rewritten). `timing.unknown_word`, naming the layer and line; the shot doesn't compile. Test: Task 3.
5. **A render that hangs or exceeds memory.** The run is killed at its timeout or memory limit, the cache entry is not written, and the error names the shot and limit. Test: Task 5.

---

## Tasks

PR order: Task 1 → 2 → 3 → 4 → 5 → 6 → then 7, 8 and 9 in any order. Each task is one PR, and the files listed are the expected ones.

### Task 1: Pin refresh and GSAP removal (PR M3.0)

**Files:** `container/pins.json`, `container/Dockerfile`, `container/render-runner/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`), `container/fixtures/{hello-world,remote-url}/index.html`, `container/render-runner/src/render.ts` (no GSAP copy), `container/README.md`, `docs/V0_1_PLAN.md` §External facts.

- [ ] **Step 1: Write the failing tests.**
  - `cinewright-check-pins` expects the new HyperFrames and Chrome versions.
  - `tools/tests/test_pins.py` asserts that GSAP is gone from the pins and the image.
  - A render-runner test asserts the work copy holds no `vendor/gsap.min.js`.
- [ ] **Step 2: Implement the bump.** Read the new release's `CHROME_VERSION`, update the pins, and convert both fixtures to WAAPI.
- [ ] **Step 3: Re-verify against the tagged source,** and record the file and line for each in `container/README.md`:
  - WAAPI seeking;
  - `window.__hf.buildReady`;
  - `data-no-timeline`;
  - the `check` flags and JSON shape, which 0.9.44 and 0.9.47 changed;
  - PNG-sequence output;
  - `snapshot`.

  Re-run the M0.2 encoding spike once on the new image, and record it.
- [ ] **Step 4: Build and check.** Build the image, then run `cinewright-check-pins`, the container tests (`CINEWRIGHT_CONTAINER_TESTS=1`) and all specimens. Expected: everything passes, smoke determinism included.
- [ ] **Step 5: Commit.** After merge, `render-image` publishes and a follow-up PR locks the digest, as in M0 and M2.

### Task 2: Delivery profiles v0 (PR M5.3)

**Files:** `registry/profiles/{landscape_web,vertical_social}.json`, `registry/README.md`, `core/schema/delivery-profile.schema.json` (optional `max_duration`, `encoding`), `cli/src/commands/init.ts` (a profile by name or path), `components/src/node/specimens-cli.ts` (registry profiles), tests.

- [ ] **Step 1: Write the failing tests.**
  - Both profiles validate and hash.
  - `cinewright init --deliverable web=landscape_web` resolves the name from `registry/profiles/`.
  - A path still works.
  - An unknown name exits 2, listing the names.
  - The specimens CLI defaults to registry profiles.
- [ ] **Step 2: Implement.** The profiles are data:
  - **`landscape_web`:** 1920×1080 at 30 fps, 48 kHz; title-safe 10%; integrated −14 LUFS and −1 dBTP, ±1 LU; 42 characters per line, 2 lines, at least 30 frames per cue.
  - **`vertical_social`:** 1080×1920 at 30 fps; title-safe 10%, plus a larger bottom zone for platform controls; the same loudness; 32 characters per line, 2 lines.
  - **`encoding`** carries codec, CRF, preset, pixel format and audio codec and bitrate. The README cites each value's delivery norm.
- [ ] **Step 3: Verify.** Run the full suite and the specimens. The M1 fixture profiles stay, for core tests only.
- [ ] **Step 4: Commit.**

### Task 3: Compile inputs: pack pin, timing table, spans (PR M3.1a)

**Files:** `core/schema/project.schema.json` (`packs`), `core/schema/log-entry.schema.json` (`pinned`), `core/src/project/init.ts`, `core/src/store/store.ts` (`pinPack`), `core/src/timing/{table,anchor,span}.ts`, `core/schema/timing.schema.json`, `cli/src/commands/{init,pack}.ts`, tests and fixtures.

**Interfaces:**
- **Store and pack:** `Store.pinPack(pack: Pack): Promise<ApplyResult>`, and `resolveProjectPack(ir, searchPath): Pack`, which throws `PackError` (`pack.not_found`, `pack.unpinned` or `pack.pin_mismatch`).
- **Timing:** `TimingTable`, plus:
  - `resolveAnchor(anchor, table): number`;
  - `shotSpan(ir, shotId, table): { start: number; end: number }`;
  - `layerTiming(ir, layerId, table): { enter: number; end: number }`, relative to the shot.

- [ ] **Step 1: Write the failing tests.**
  - `init --pack playful` pins playful.
  - Editing a token in a copied pack makes `resolveProjectPack` fail with `pack.pin_mismatch`, naming both versions (Review Focus 1).
  - `pack pin` recovers, and replaying the log reproduces the pin.
  - Anchors resolve at a line's start, end and word, with offsets, and a missing word gives `timing.unknown_word` (Review Focus 4).
  - Span rules hold in all three forms, and the no-span case is an error.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Rebuild** the M1 reference project with `--pack neutral` (its log gains the pin), and update the goldens.
- [ ] **Step 4: Verify.** Run the full suite.
- [ ] **Step 5: Commit.**

### Task 4: Shot compiler (PR M3.1b)

**Files:**
- Create: `plugins/backend-hyperframes/{package.json,manifest.json,src/{compile,errors,index}.ts,test/…,README.md}`, `components/src/node/composition.ts`.
- Change: `components/src/node/specimen.ts` (now calls `writeComposition`), `core/src/pack/tokens.ts` (`cssValue`), `core/src/pack/load.ts` (`pack.token_unsafe`), `cli/src/commands/compile.ts`.
- Add the reference timing fixture `cli/test/fixtures/m1-reference/timing.json`.

**Interfaces:**
- `compileShot({ ir, shotId, deliverableId, pack, catalog, timing, assets, outDir }): { dir; spec: MountSpec; inputs: CompileInputs }`.
- It throws `CompileError` with `{ entity, pointer, rule }` items:
  - `compile.missing_prop`;
  - `compile.unknown_region`;
  - `compile.unknown_span`;
  - `compile.unsafe_value`;
  - `compile.transition_too_long`.

- [ ] **Step 1: Write the failing tests.**
  - The reference shot `s03.sh01` compiles for both deliverables, and its mount spec matches goldens.
  - The same IR compiles under neutral and playful by changing only `style.pack` (and re-pinning). The specs differ only in `css` and `js`.
  - Compiling twice gives byte-identical folders.
  - A missing required prop names the layer.
  - Hostile values are rejected (Review Focus 2).
  - Specimens are byte-identical before and after the composition-writer extraction.
- [ ] **Step 2: Implement.**
  - Extract `writeComposition` first, with the specimen goldens unchanged.
  - Then write the compiler: span → layer timing → region boxes → tokens per layer through `resolveEntity` → `tokenEmit` through `cssValue` → mount spec.
- [ ] **Step 3: Verify in the container.** Run `render-job check` on the two compiled reference compositions. Expected: ok.
- [ ] **Step 4: Commit.**

### Task 5: Backend interface and renderer adapter (PR M3.2a)

**Files:** `plugins/backend-hyperframes/src/{render,docker,limits}.ts`, `core/src/project/layout.ts` (`cacheDir`), `cli/src/commands/render-shot.ts`, `tools/src/cinewright_tools/container.py` (the same limits for the Python tools), tests.

**Interfaces:** `renderShot({ compiled, image, cacheDir, settings }): { key; dir; framemd5; sha256 }`. It renders a PNG sequence and encodes with the pinned FFmpeg per the M0.2 spike, keeping the frames for segments.

- [ ] **Step 1: Write the failing tests.**
  - **Unit:** the Docker argument list has the network off and every limit.
  - **Unit:** the timeout scales with the frame count.
  - **Container:** the reference shot renders, and the cache holds every file.
  - **Container:** a composition that never becomes ready is killed at its timeout, with no cache entry written and the error naming the shot (Review Focus 5).
  - **Container:** a video plate's frame hashes change over time (audit §3.1).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Run the container tests.
- [ ] **Step 4: Commit.**

### Task 6: Render key v1, cache hits, determinism in CI (PR M3.2b)

**Files:** `core/src/graph/render-key.ts` (v1 from `CompileInputs`), `core/src/graph/deps.ts` (dirty sets on v1 keys), `plugins/backend-hyperframes/src/render.ts` (cache hits), `.github/workflows/render-smoke.yml` (two renders of the reference shot compared, on both runners), tests.

- [ ] **Step 1: Write the failing tests.** Each of these changes the key:
  - a token that a component reads implicitly;
  - a font file;
  - the runtime bundle;
  - the profile;
  - the image digest;
  - a region in `layouts.json`.

  Editing the pack's `README.md` doesn't change the key. An unchanged shot is a cache hit, with no container run. M1.5's dirty-set tests still pass on v1 keys.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Run the determinism job in CI.
- [ ] **Step 4: Commit.**

### Task 7: Transition segments (PR M3.3)

**Files:** `plugins/backend-hyperframes/src/segment.ts`, `core/src/timing/span.ts` (overlap spans), `core/src/graph/deps.ts` (segments at the new spans), `docs/DESIGN_SPEC.md` (the timing rule recorded in D34), tests.

- [ ] **Step 1: Write the failing tests.**
  - **Frame counts:** for every combination of cut, cross-dissolve and wipe, the outgoing body, the segment and the incoming body add up to the timeline exactly.
  - **Too long:** a transition longer than either shot's span fails, naming the scene (Review Focus 3).
  - **Container:** a dissolve and a wipe render twice with identical hashes.
  - **Container:** the segment's first frame matches the outgoing shot's frame at the same time, and its last frame matches the incoming shot's frame at the same time, within the encoder's tolerance.
  - **Only adjacent segments:** a one-shot edit dirties only that shot and its adjacent segments.
- [ ] **Step 2: Implement** (FFmpeg `xfade` custom expression with eased progress, from tokens).
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

### Task 8: Caption layer (PR M3.4)

**Files:** `plugins/backend-hyperframes/src/captions.ts`, tests.

- [ ] **Step 1: Write the failing tests.**
  - A deliverable with `burn_in_captions` gets a `caption_track` layer per shot, with cues from the timing table's lines; one without gets none.
  - A cue spanning a cut is split at the cut and drawn identically on both sides: same text, box and size.
  - A caption edit dirties only the shots it touches.
- [ ] **Step 2: Implement.** The cue text comes from the script lines, broken by the profile's caption rules (M2's `breakCaption`).
- [ ] **Step 3: Verify in the container.**
- [ ] **Step 4: Commit.**

### Task 9: Keyframe capture (PR M3.5)

**Files:** `container/render-runner/src/snapshot.ts` (`render-job snapshot --at`), `plugins/backend-hyperframes/src/keyframes.ts`, tests.

- [ ] **Step 1: Write the failing tests.**
  - The sample rule picks, for each shot, the frame after every layer's entrance where the most layers are visible, plus the hold's midpoint.
  - Each still's PNG equals the cached render's frame at that time.
  - The text boxes (selector, layer id, box) are captured at the same time.
  - Running twice gives identical outputs.
- [ ] **Step 2: Implement.** Re-verify the HyperFrames `snapshot` command on the M3.0 release; if it can't give text boxes, the runner reads them from the page at the same seek.
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

## Done when (M3 AC map)

| M3 acceptance criterion (V0_1_PLAN.md) | Proven by |
| --- | --- |
| The spec's scene example (motion-graphics shot) compiles and renders in both aspect ratios | Tasks 4 and 5 (the reference shot, both deliverables, check ok) |
| The determinism test passes | Task 6 (two renders, two runners, in CI) |
| A revised shot re-renders only itself and its adjacent transition segments | Tasks 6 and 7 (v1 keys, segment dirty sets) |
| The HyperFrames API in use is checked against current upstream docs and pinned | Task 1 (the bump, with source references recorded) |
| Encoding follows the M0.2 spike | Tasks 1 and 5 (PNG sequence, pinned FFmpeg, the spike re-run) |
| The audit's F3, F4, F5 and F17 | Tasks 6, 3, 4 and 5 |
