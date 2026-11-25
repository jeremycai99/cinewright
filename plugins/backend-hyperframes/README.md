# @cinewright/backend-hyperframes

The HyperFrames backend plugin (Apache-2.0; invariant 5): the only producer of HTML (D31). Agents emit typed IR (components, props, token references, anchor-relative timing); this plugin compiles it.

## `compileShot` (M3.1b)

```ts
compileShot({ ir, shotId, deliverableId, pack, catalog, timing, assets?, outDir })
  → { dir, frames, spec: MountSpec, inputs: CompileInputs }
```

For one shot and one deliverable:

1. **Pack:** `pack` must be the project's pinned pack (`style.pack` and `packs`); otherwise PackError `pack.unpinned` or `pack.pin_mismatch`. Callers resolve it with core's `resolveProjectPack`.
2. **Span:** `shotSpan` from the timing table gives the composition's length.
3. **Layout:** the shot's template for the deliverable's aspect class, and each layer's region in it. The box is `regionBox` (pack grid inside the profile's title-safe area).
4. **Tokens:** the cascade (`resolveEntity`) for the shot gives the root CSS variables; each layer's own cascade gives its `js` and the CSS variables that differ from the root. Every CSS value passes core's `cssValue` (audit F5).
5. **Timing:** `layerTiming`, relative to the shot.
6. **Write:** the mount spec goes to the components package's `writeComposition`, the same writer specimens use: `index.html`, `runtime.js` and the pack's fonts. Assets named in props (any string prop equal to a key of `assets`) are copied to `assets/<id><ext>`.

Compiling the same inputs twice writes byte-identical folders. `inputs` lists everything the frames depend on besides the renderer: the mount spec, root CSS, font and runtime hashes, asset hashes, the compiler version, the profile hash and the pack's content hash (render key v1, M3.2b, adds the renderer side).

### Errors

`CompileError` lists every problem, each with the entity, the field (JSON Pointer) and a rule:

| Rule | Meaning |
| --- | --- |
| `compile.missing_prop` | A required prop of the layer's component is not set. Patches allow it, because layers are built across patches (M2). |
| `compile.unknown_region` | The shot has no template for this aspect class in the pack, or the layer has no region in it. |
| `compile.unknown_component` | The layer's component is not in the catalog. |
| `compile.unknown_span` | The shot has no end anchor, no duration and no next shot. |
| `compile.unsafe_value` | A token value holds `<`, `>`, `{`, `}`, `;`, a backslash or a double quote. |
| `timing.unknown_line`, `timing.unknown_word`, `timing.empty_span`, `timing.outside_shot` | The timing table does not cover an anchor, a span is empty, or a layer enters outside its shot (an exit past the shot's end is cut there). |
| `compile.unknown_deliverable`, `compile.unknown_shot` | The ids do not exist. |

## `renderShot` (M3.2a, M3.2b)

```ts
renderShot({ compiled, shotId, renderer, cacheDir, limits? }) → { key, dir, framemd5, sha256, hit }
```

Runs `render-job --format mp4+frames --fps <rate>` in the render image with the network off and the run limits (`src/limits.ts`; container README), into `<cacheDir>/<key>/`: `frames/`, `body.mp4`, `framemd5.txt`, `sha256.txt`, `render-log.jsonl`, `inputs.json`. The entry appears only after a successful render. The cache is disposable (D37).

- **Key:** render key v1 (core `renderKeyV1`): the compile inputs plus `renderer`, which `resolveRenderer(imageRef)` builds from the image's content digest (`docker image inspect`), the HyperFrames version and `render-settings.json`. A shot whose key is cached runs no container.
- **Planning:** `planShot` computes the mount spec and compile inputs without writing anything; `shotRenderKey(options, renderer)` is its v1 key, which the engine passes to core's `dirtyNodes` as `inputs.renderKey`.
- **Failures:** `RenderError` with `render.timeout` (killed after 120 s plus 1 s per frame), `render.memory` (exit 137 at the memory limit), `render.failed` (render-job's own error) or `render.unsupported_fps`, naming the shot.

CI renders the reference shot twice on each of two runners (`.github/scripts/reference-shot.sh`): both renders and both runners must give identical `framemd5.txt` and `sha256.txt`, and a third run must be a cache hit.

## Transition segments (M3.3, D34)

`transitionsFor(ir, deliverable, pack, fps)` says which scene transitions render as segments: `cross_dissolve` and `wipe`, unless the scene's resolved `transition.<type>.enabled` is false, over the transition's own `duration` (frames) or `transition.<type>.duration` (ms). Core's `segmentsOf` places each overlap centred on the cut (`h = floor(d / 2)` frames before, `d − h` after; total length unchanged) and fails with `compile.transition_too_long`, naming the scene and both shots, when it is longer than either shot.

- **Compiling:** `planShot` compiles each shot over its span plus its overlaps (`timeline: { start, before, after }`, `segments: { incoming, outgoing }`). A layer that lasts to an outgoing segment stays to the end of the overlap with `timing.exit: false`: the segment is its exit. A layer that starts with a shot that has an incoming segment is on from the overlap's start: the segment is its entrance.
- **Bodies:** `renderShot` keeps every frame as PNG but encodes `body.mp4` from the frames outside the overlaps only (`render-job --body <start>,<end>`), so assembly concatenates bodies and segments without re-encoding.
- **Rendering:** `renderSegment` blends the two shots' cached PNG frames over the overlap with the image's FFmpeg (`blend`, one weight per frame from the scene's easing, `easingWeights`; a wipe moves a soft edge in its `direction`, `softness` of the frame wide), encoded with the render settings' encoder, bit-exact and single-threaded. Nothing re-renders in the browser. It is cached in `.cinewright/cache/segments/<key>/` by both shots' render keys and the blend.
- **Checked:** the segment's first frame matches the outgoing shot's frame at that time and its last frame the incoming shot's (PSNR over 38 dB); two renders are identical.

## Burned-in captions (M3.4, D35)

When the deliverable's `burn_in_captions` is true, `planShot` adds a `caption_track` layer, `<shot>.captions`, on top of the shot's layers. Its cues are the lines of the shot's own sequence (its scenes' `lines` and every line its shots and layers anchor to) that the timing table places in the shot's compile span, clipped to it (`captionCues`). A line too long for the profile's caption rules is split into several cues at word boundaries, each starting at its first word's frame; the component breaks each cue into lines. The layer is styled from the sequence's tokens (all of them, not a difference from the shot's) and placed in the pack's `captions` region, so a cue split by a cut has the same text, box and size on both sides. A deliverable that does not burn captions in gets no layer; a pack with no `captions` region fails with `compile.unknown_region` at `/burn_in_captions`.

## Plugin

`manifest.json` declares a `backend` plugin (M5.4a) with the five methods of the SDK's `BACKEND_KIND` and the family capability `backend.html` (shots with `backend: "html"` route here). Every method takes `{ project, deliverable, timing, image?, pack_path? }`, where `timing` is the solver's output (`{ table, sequences, scenes, shots }`):

| Method | Extra params | Returns |
| --- | --- | --- |
| `render.plan` | `shot` | `{ key, frames, body, segments }`, writing nothing |
| `render.composition` | `shot`, `out_dir` (no image needed) | `{ dir, inputs, frames }` |
| `render.shot` | `shot` | `{ key, dir, frames, body_frames, framemd5, sha256, hit }` |
| `render.segment` | `scene` | the segment into the next scene, rendering both shots if needed |
| `render.keyframes` | `shot` | `{ key, keyframes }` |

Compile, pack and timing errors are `invalid_request` with `data.issues`; render errors are `provider_error` with `data.rule`, retryable only for `render.failed`. Each call compiles into a scratch folder of its own under `.cinewright/compiled/`, so two renders of one shot can run at once.

**Cache commits (G9):** renders, segments and keyframes are committed with core's `commitCacheDir`: a rename into place, and when the key already exists the new folder is discarded and the existing one kept. No code path removes a committed entry.

The CLI and engine reach this package only through its manifest (`cinewright-check-boundaries` rule `plugin-import`).

## Developer command

```bash
cinewright compile <shot_id> --deliverable <id> --timing <timing.json> --out <dir>
```

A developer tool until `cinewright render` (M5.4). The timing table comes from a file until narration writes it (M4.2); `cli/test/fixtures/m1-reference/timing.json` is the reference project's.
