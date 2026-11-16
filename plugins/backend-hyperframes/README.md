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
| `timing.unknown_line`, `timing.unknown_word`, `timing.empty_span`, `timing.outside_shot` | The timing table does not cover an anchor, or a span is empty or leaves its shot. |
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

## Plugin

`manifest.json` declares a `backend` plugin with the capability `render.composition`. `createPlugin()` answers it with `{ project, shot, deliverable, timing, out_dir, pack_path? }` and returns `{ dir, inputs }`; compile and pack errors are `invalid_request`.

## Developer command

```bash
cinewright compile <shot_id> --deliverable <id> --timing <timing.json> --out <dir>
```

A developer tool until `cinewright render` (M5.4). The timing table comes from a file until narration writes it (M4.2); `cli/test/fixtures/m1-reference/timing.json` is the reference project's.
