# M1 — IR v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The IR contract everything else builds on: JSON Schemas with authorship wrappers, generated TS and Python types, a single-writer IR store with patches, revisions, authorship enforcement and a git-tracked patch log, the cascade resolver, render keys, the plugin contract v0, and the `cinewright init`, `patch` and `show` commands that agents use to edit a project.

**Architecture:** JSON Schema files in `core/schema/` are the source of truth (D4). `@cinewright/core` (TypeScript) validates, canonicalizes, hashes and writes the IR; it is the only writer (D30, D40). Python reads the IR through generated Pydantic models in `cinewright-ir` and never writes or hashes it. The store applies patches as journaled transactions under an exclusive file lock and appends every outcome to `log/patches.jsonl`. `@cinewright/plugin-sdk` holds the plugin envelope, the in-process interface, the subprocess host and the conformance kit, and `cinewright-plugin-sdk` is its Python counterpart. `@cinewright/cli` is a thin layer over core.

**Tech Stack:** As M0 (Node 24.22.3, pnpm 12.18.0, TypeScript 7.0.2, Vitest 5.1.0, Biome 2.6.7, Python 3.13, uv 0.13.8, pytest 9.2.0, Ruff 0.17.5, Pyright 1.1.414), plus Ajv 8.20.0, canonicalize 5.1.0, fast-check 4.10.2, json-schema-to-typescript 16.0.0, datamodel-code-generator 0.96.0 and Pydantic 2.14.3.

**Spec:** `docs/V0_1_PLAN.md` §M1 (tasks M1.1–M1.9 and M1 conventions 1–16), with `docs/DESIGN_SPEC.md` D4, D25–D33, D40 and D41, the scene and cast examples in its "What a scene spec holds" and "Cast bible entry" sections, and `AGENTS.md` §2 and §3 (invariants 1, 2, 3, 4, 5, 8 and 12).

## Decisions this plan makes

Versions were read from npm and PyPI on 2026-11-14.

| Choice | Value | Why |
| --- | --- | --- |
| Schema validator | Ajv 8.20.0, `Ajv2020` class, `strict: true`, `allErrors: true`; custom keywords `x-authorable` and `x-entity` registered as annotations | The 2020-12 class is the documented path. Strict mode catches typos in schemas. |
| `format` keyword | Not used; patterns instead | The two code generators treat `format` differently, and Ajv needs `ajv-formats` for it. |
| JCS hasher | `canonicalize` 5.1.0 (Apache-2.0) | It implements RFC 8785 exactly, including ECMAScript number formatting. It is tested against the RFC vectors in M1.7. |
| Stored-form writer | In-house: keys sorted by UTF-16 code units (same order as JCS), 2-space indent, `\n` line endings, one trailing newline, numbers formatted as JCS | One key order for both forms (convention 1). It is about 30 lines. |
| Property tests | fast-check 4.10.2, `numRuns: 1000` minimum | fast-check prints the seed and path on failure, which the M1.2a AC requires. |
| Type generators | json-schema-to-typescript 16.0.0 and datamodel-code-generator 0.96.0 (Pydantic v2 output), Pydantic 2.14.3 | They are named in §External facts. datamodel-code-generator moved from 0.95.0 to 0.96.0 since 2026-11-13, so this plan pins the current release and updates §External facts. |
| Wrapper encoding | Each authorable field is an inline object schema `{ "state": State, "value"?: T }`, marked `"x-authorable": "field"`. The rule that `value` is absent exactly when `state` is `open` is a semantic rule (`wrapper.value_presence`), not schema. | Convention 5 forbids `if`/`then` and `dependent*`, and both generators handle this shape. The schema lint (Task 1) checks every marked node has exactly this shape. |
| Entity marker | `"x-entity": "<kind>"` on every entity schema | The store, the semantic validator and `show` find entities and their kinds from the schemas, not from hand-kept lists. |
| Entity common properties | `id` (plain), `origin` (plain, `"user"` or `"agent"`, set by the store on insert), `locked` (plain, optional `true`, set only by an entity `lock`) | Convention 13 needs to know which entities a user inserted, and convention 8 needs an entity lock. Both are part of the IR, so `state_hash` covers them. |
| Store metadata | None in the IR files. `revision` and `state_hash` live only in `log/patches.jsonl`. | Convention 11's hash then covers the whole files, and a patch to one sequence rewrites only that sequence's file. |
| Hash format | `"sha256:<64 lowercase hex>"` everywhere (asset hashes, profile hashes, `state_hash`, render keys) | Self-describing, and matches `container/image.lock.json`. |
| `$id` and `$ref` | `$id` is `https://cinewright.invalid/ir/0/<name>.schema.json`; every cross-file `$ref` is relative (`common.schema.json#/$defs/id`). Tools load schemas from `core/schema/`, never over the network. | `.invalid` can never resolve (RFC 2606), so no tool can fetch it by accident. |
| Atomic multi-file apply | A journal in `.cinewright/txn/r<revision>/`: the new files and the log line are written there, then a `COMMITTED` marker is renamed into place (the commit point), then the files are renamed over the targets and the log line is appended, then the journal is removed. When the store opens a project it rolls a committed journal forward and deletes an uncommitted one. | The M1.4a AC requires old-or-new after a kill at any point, and an apply can touch the project file, sequence files and the log. |
| Store lock | `.cinewright/store.lock`, created with `O_EXCL`, holding the pid, hostname and time. A lock whose pid is not running on the same host is stale and taken over; otherwise the store waits up to 10 s, then fails with exit code 7 naming the holder. | No dependency, and the stale case is handled. `proper-lockfile` (last released 2021) uses mtime staleness, which misfires on slow disks. |
| Session id | `CINEWRIGHT_SESSION_ID` if set, otherwise a random UUID per CLI process; recorded on every log entry (D41) | — |
| Test clock | `CINEWRIGHT_FIXED_TIME` (ISO-8601 UTC) replaces the log timestamp. Documented as a test switch. | The M1.9 reference build must be byte-identical, logs included. |
| Gate authors | A gate is a `job` author whose name is in the store's gate table (`gate.script`, `gate.storyboard`, `gate.final`); only those jobs may send `lock`. | Convention 10 lists four author kinds and says gates may lock. This keeps the four kinds. |
| User edits to locked fields | A user `set`, `unset` or list change on a `locked` field, list or entity is rejected (`authorship.locked`, "unlock first"). | M1.2a's table says "user: any→user". This plan reads that as any unlocked state. Otherwise `lock` would protect only against agents, and a gate's lock would vanish with one user edit. If wrong, the cost is one rule in `authorship/rules.ts`. |
| Revert | Each applied log entry stores `before` snapshots of every node it touched (field wrapper, list order, or whole entity). A revert is a user patch that restores them under a new revision; it conflicts if a later revision touched the same nodes. | "Inverse" ops would need a ninth op to restore a non-user state. Snapshots stay out of the wire format. |
| `suggest` | A patch whose ops are all `suggest` is stored as pending. Mixing `suggest` with other ops is a validation error (`patch.mixed_suggest`). | It keeps "all or nothing" (convention 13) unambiguous. |
| `move` | Within the same list only. Moving to another parent is `remove` plus `insert` with a new id. | Ids are immutable and never reused (convention 9). Cross-parent move can come later without a format change. |
| Session authors | A `session` patch takes `user` state when it applies, whether approved or because propose-first is off ("dictated", D25). With propose-first on (the default), a `session` patch in `apply` mode is stored as pending, exactly as `propose`. | D25: dictated or approved values become `user`. |
| JSON-RPC framing | Newline-delimited JSON on stdin and stdout, one message per line; stderr is the plugin's log | Simple in Python's standard library. The Python SDK exits when stdin closes, so a plugin cannot outlive a host that was killed. |
| Profiles in M1 | Two fixture profiles in `core/test/fixtures/profiles/` (`landscape_1080p30`, `portrait_1080p30`). `init` copies each profile body and hash into the project (convention 16). Adding a profile after `init` is out of scope until M5.3. | M1.7 says real profiles are M5.3. |
| Show format | Hand-written printer; no YAML library | Convention 14: output only, never parsed. |

**Approved 2026-11-14** for native execution in the maintainer's Claude Code session.

## Global Constraints

- The M1 conventions 1–16 in `docs/V0_1_PLAN.md` bind every task. A deviation needs a ruling in the ledger and a note in the PR.
- JSON Schema 2020-12 subset: no `if`/`then`/`else`, `prefixItems`, `dependent*`, `unevaluated*` or `format`; `oneOf` only with a `const` discriminator (convention 5).
- Property names are `snake_case` and never a Python or TypeScript keyword (`in`, `from`, `class`, `default`, …), so both generated models keep the JSON names without aliases.
- Only `@cinewright/core` writes or hashes the IR. Python packages read it through `cinewright-ir`'s generated models (M1.7).
- Every IR write goes through the store (D25, D40). Test fixtures in M1.1 are written by hand (convention 4). From M1.9 on, valid project fixtures are built through the store.
- Stored times are integer frames, and audio offsets are integer samples (D27, convention 2).
- No taste in core (AGENTS.md §2): schemas carry no default colors, fonts, easing, durations, voices or genres. The scene and cast examples from the spec are test fixtures.
- Ids are ASCII by pattern. Everything else, including map keys such as lexicon terms, may be any Unicode and must round-trip byte-identically.
- All new dependencies are pinned exactly and installed frozen.
- ESM only; TypeScript strict options as in M0.
- Commits end with the `Co-Authored-By` trailer the harness specifies. Pushing, opening PRs and merging each need the maintainer's go-ahead at execution time.

## Review Focus

1. **Non-ASCII map keys and text** (lexicon terms such as `Zoë` or `東京`, emoji with surrogate pairs, right-to-left lines). The stored form sorts keys in the same UTF-16 order as JCS, and load → save is byte-identical. Test in Task 5.
2. **Time inputs at a rational frame rate.** `"18s"`, `"1500ms"` and `"00:00:18:00"` normalize to the nearest frame at 30000/1001, with ties rounding half up. A malformed time names the op index and path. Test in Task 6.
3. **A stale or held store lock.** A lock left by a killed process is taken over; a lock held by a live process makes a second writer wait, then fail with exit 7 naming the holder. Test in Task 7.
4. **Ids that would escape the project directory** (`../x`, `a/b`, `CON`, an uppercase id). They are rejected by the id pattern before any file is written; sequence file names come only from validated ids. Test in Task 6.
5. **Reverting a revision whose nodes changed later.** The revert fails with a conflict naming the later revision and writes nothing. Test in Task 6.

---

## IR v0 field map

This section is the shape every schema task implements. "Field" is an authorable wrapper (`x-authorable: field`), "list" an entity list (`x-authorable: list`), "map" a map with one wrapper per entry (`x-authorable: map`), and "plain" a value that is not wrapped. Every entity also has `id`, `origin` and optional `locked` (Decisions). `Ref<kind>` is an id that must resolve to an entity of that kind (checked by the semantic validator). Each schema PR copies its rows into `core/schema/README.md` (convention 6).

**Common** (`common.schema.json` `$defs`): `id`, `state`, `frames` (integer ≥ 0), `samples` (integer ≥ 0), `rational` (`{ num: integer ≥ 1, den: integer ≥ 1 }`), `hash`, `aspect_class` (`landscape` · `portrait` · `square`), `token_ref` (`{ token: string }`, a dotted token path), `token_value` (string · number · boolean · `token_ref`), `anchor` (convention 15: `{ line: Ref<line>, point: "start" | "end" | "word", word?: integer ≥ 0, offset: integer frames }`; `word` is present exactly when `point` is `word`, rule `anchor.word_presence`), `license` (`{ terms: string, commercial_use: boolean, attribution?: string }`).

| Entity (file) | Fields |
| --- | --- |
| **Project** (`cinewright.json`, `x-entity: project`) | plain: `schema_version` (const `1`), `profiles` (object keyed by profile id: `{ hash, body: DeliveryProfile }`, written only by `init`). field: `title`, `brief`, `autonomy` (`auto` · `guided` · `directed` · `manual`), `budget` (`{ currency: "USD", cap: number > 0 }`), `policies` (`{ require_commercial_license: boolean }`). plain container `settings` → field `propose_conversational_edits` (boolean). plain container `style` → field `pack` (pack id string), map `overrides` (token path → `token_value`). list: `deliverables` (Deliverable), `sequences` (**ids only**, in order; each body is `sequences/<id>.json`), `cast` (CastMember), `assets` (Asset). plain: `script` (Script entity). |
| **Deliverable** (`x-entity: deliverable`) | field: `profile` (profile id present in `project.profiles`), `label`, `burn_in_captions` (boolean) |
| **DeliveryProfile** (`delivery-profile.schema.json`; a data file, not an entity, no wrappers) | `schema_version`, `id`, `name`, `frame_rate` (`rational`), `sample_rate` (integer), `width`, `height`, `aspect_class`, `safe_zones` (`{ action, title }`, each `{ top, right, bottom, left }` as fractions 0–0.5), `loudness` (`{ integrated_lufs, true_peak_dbtp, tolerance_lu }`), `captions` (`{ max_chars_per_line, max_lines, min_display_frames }`) |
| **Script** (`x-entity: script`) | list: `beats` (Beat) |
| **Beat** (`x-entity: beat`) | field: `summary`. list: `lines` (Line) |
| **Line** (`x-entity: line`) | field: `text`, `direction`, `speaker` (`Ref<cast_member>`), `on_screen` (boolean: speaker visible), `lipsync` (boolean), `on_screen_text` (string) |
| **CastMember** (`x-entity: cast_member`) | field: `role` (`narrator` · `character`; v0.1's narrator-only rule is P0 intake, M7.1), `display_name`, `on_screen` (boolean), `visual` (`{ sheet: [Ref<asset>], wardrobe?, style? }`), `consent` (`{ synthetic: boolean, record?: Ref<asset> }`). plain container `voice` → field `description` (`{ language?, timbre?, accent?, text? }`), map `lexicon` (term → pronunciation), map `bindings` (provider id → `{ voice_id?, voice?, model?, settings? }`). plain container `performance` → field `baseline`, `pace_wpm` (integer), `tics` (string list). |
| **Asset** (`x-entity: asset`) | all plain (measured data): `hash`, `media_type`, `bytes`, `role` (`take` · `music` · `sfx` · `image` · `video` · `font` · `composition` · `reference` · `consent` · `other`), `line` (`Ref<line>`, takes only), `provenance` (`{ provider, model?, plan_tier?, request_hash? }`), `license`, `words` (takes only: `[{ text, start: samples, end: samples }]`) |
| **Sequence** (`sequences/<id>.json`, `x-entity: sequence`) | field: `title`, `mood` (string list), `music_bed` (string). plain container `style` (as Project's, without `pack`). list: `scenes` (Scene) |
| **Scene** (`x-entity: scene`) | field: `intent`, `duration` (`{ target: frames, flex: number 0–1, sync: "voiceover" | "music" | "fixed" }`), `mood` (string list), `cast` (`[Ref<cast_member>]`), `lines` (`[Ref<line>]`, in order), `transition_out` (`{ type: "cut" | "cross_dissolve" | "wipe" | "match_cut", to?: Ref<scene>, duration?: frames, on?: string }`), `sound` (`{ music_cue?, sfx: [string], duck_under_vo_db?: number }`), `gates` (list of `script` · `storyboard` · `animatic` · `final`). plain container `style` (as Sequence's). list: `shots` (Shot) |
| **Shot** (`x-entity: shot`) | field: `type` (`motion_graphics` · `generative_footage` · `stock` · `three_d` · `live_action`), `backend` (string), `framing` (string), `subject` (`Ref<cast_member>`), `camera` (`{ move, ease?: token_value, amount?: number }`), `duration` (frames), `anchors` (`{ start: anchor, end?: anchor }`), `references` (list of refs to assets or cast members). map `layout` (`aspect_class` → `{ template: string }`). plain container `style`. list: `layers` (Layer) |
| **Layer** (`x-entity: layer`, D31) | field: `component` (component id), `motion` (list of `{ preset: string, params?: object }`), `timing` (`{ enter: anchor, exit?: anchor }`). map `props` (prop name → `token_value` or JSON object), map `layout` (`aspect_class` → `{ region: string }`). plain container `style`. |

**Stored-form mapping of the spec examples** (recorded in the fixture's README): `duration.target` is in frames at 30 fps; the cast example's `performance.pronunciations` becomes `voice.lexicon` (D29); `visual.sheet` paths become asset ids; the scene's `dialogue` becomes `lines` (ids) plus the Line entities in the script; `elements` becomes one Layer per component; `refs: [cast.dr_lin.sheet]` becomes `references: ["dr_lin", "<sheet asset id>"]`; `camera.ease: style.motion.ease_out_expo` becomes `{ "token": "motion.ease_out_expo" }`; `framing: medium_close, 50mm, shallow DOF` stays one string.

---

## File structure

```
core/
  schema/                      # source of truth (D4); shipped in the package
    README.md                  # authorable-field tables, dialect rules, error codes
    common.schema.json  project.schema.json  delivery-profile.schema.json
    script.schema.json  cast.schema.json  asset.schema.json
    sequence.schema.json  scene.schema.json  shot.schema.json  layer.schema.json
    patch.schema.json  log-entry.schema.json
  scripts/gen-types.mjs        # runs json-schema-to-typescript over core/schema → src/generated/ir.ts
  src/
    generated/ir.ts            # generated, checked in, drift-checked
    schema/{load,validate,errors}.ts
    ir/{index,semantic,paths}.ts       # entity index from x-entity, semantic validator, pointer helpers
    canonical/{stored,hash}.ts
    time.ts
    project/{layout,files,init}.ts     # on-disk layout, split/inline sequences, init
    cas/cas.ts
    store/{store,lock,txn,log,patch,apply,snapshot,conflict,scopes,pending}.ts
    authorship/rules.ts
    cascade/resolve.ts
    graph/{deps,render-key}.ts
  test/fixtures/
    schema/<schema>/{valid,invalid}/<case>.json   (+ <case>.errors.json for invalid)
    profiles/{landscape_1080p30,portrait_1080p30}.json
    jcs/vectors.json
    cascade/<case>/{ir.json,pack.json,expected.json}
    graph/<case>/…
    write-scopes.test.json
  py/src/cinewright_ir/models.py        # generated (datamodel-code-generator), checked in
plugins/
  sdk-ts/schema/manifest.schema.json
  sdk-ts/src/{manifest,loader,plugin,errors,kit,rpc,host}.ts
  sdk-ts/test/fixtures/stub-plugin/{manifest.json,index.ts,golden.json}
  sdk-py/src/cinewright_plugin_sdk/{rpc,plugin}.py
  sdk-py/tests/fixtures/stub_plugin/{manifest.json,plugin.py}
cli/
  src/{bin,args,output,exit-codes}.ts  src/commands/{init,patch,show}.ts  src/show/{view,diff}.ts
  README.md                    # commands, ops, exit codes (agents read this)
  test/fixtures/m1-reference/{build.sh,patches/*.json,project/…,golden/…}
```

**Validation error shape** (used by every validator, matched exactly by fixtures): `{ "entity": <nearest enclosing entity id or null>, "pointer": <JSON Pointer relative to that entity>, "rule": <code> }`, sorted by entity, then pointer, then rule. Schema errors map Ajv's keyword to `schema.<keyword>` (`schema.required`, `schema.additionalProperties`, `schema.pattern`, `schema.enum`, `schema.type`, `schema.minimum`, …). Semantic codes: `wrapper.value_presence`, `anchor.word_presence`, `semantic.duplicate_id`, `semantic.dangling_ref`, `semantic.ref_kind`, `semantic.frame_rate_mismatch`, `semantic.id_reused`, `semantic.unknown_profile`, `semantic.profile_hash`.

**CLI exit codes** (`cli/src/exit-codes.ts`, documented in `cli/README.md`): 0 ok (including "stored as pending" for `propose` and session edits); 1 internal error; 2 usage; 3 invalid patch or IR (schema, semantic, path, op not permitted); 4 conflict; 5 blocked by authorship and stored as a pending suggestion; 6 project failed to load (edited outside the store, corrupt CAS, missing file); 7 store lock timeout.

---

## Task 1: Common definitions, Project, Deliverable, DeliveryProfile (PR M1.1a)

**Files:**
- Create: `core/schema/{common,project,delivery-profile}.schema.json`, `core/schema/README.md`
- Create: `core/src/schema/{load,validate,errors}.ts`, `core/src/ir/{index,semantic}.ts` (only `wrapper.value_presence` in this task)
- Create: `core/test/schema/{meta,lint,fixtures}.test.ts`, `core/test/fixtures/schema/{common,project,delivery-profile}/…`, `core/test/fixtures/profiles/*.json`
- Modify: `core/package.json` (dependency `ajv@8.20.0`; `files` adds `schema`)

**Interfaces:**
- Produces: `type DocumentKind = "project" | "sequence" | "delivery_profile"` (extended by later tasks); `validateDocument(kind: DocumentKind, doc: unknown): ValidationError[]` (schema plus the semantic rules that need only one document); `interface ValidationError { entity: string | null; pointer: string; rule: string }`; `loadSchemas(): SchemaSet` (reads `core/schema/` relative to the package); `entityIndex(schemaSet, doc): Map<id, { kind, pointer, parent }>`.

- [ ] **Step 1: Write the failing tests.**
  - `meta.test.ts` — "every schema validates against the 2020-12 meta-schema": `ajv.validateSchema` for each file in `core/schema/`.
  - `lint.test.ts` — "schemas use only the allowed dialect": a walk that fails on the forbidden keywords (Global Constraints), on `oneOf` whose branches lack a `const` discriminator, on non-`snake_case` or keyword property names, on any `$def` or entity schema without `title`; and "every x-authorable node has the wrapper shape": `field` nodes are `{ type: object, additionalProperties: false, required: ["state"], properties: { state: $ref state, value: … } }`, `map` nodes have `additionalProperties` of that shape, `list` nodes have a `value` array whose `items` carry `x-entity`.
  - `fixtures.test.ts` — "valid fixtures pass" (each `valid/*.json` returns `[]`) and "invalid fixtures fail with exactly the expected errors" (each `invalid/<case>.json` deep-equals `<case>.errors.json`). Cases at minimum: bad id pattern, id over 64 characters, open wrapper with a `value` (`wrapper.value_presence`), valued wrapper without `value`, unknown property, wrong `autonomy` enum, `frame_rate.den` 0, a profile missing `loudness`.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL (no schemas, no harness).
- [ ] **Step 3:** Write the three schemas per the field map, the Ajv harness (`Ajv2020`, strict, `allErrors`, annotation keywords registered, schemas added by `$id`), the error mapper (Ajv instance path → nearest entity id plus relative pointer, via `entityIndex`), and the `wrapper.value_presence` rule. Write `core/schema/README.md`: the dialect rules, the authorable-field tables for these schemas, and the error codes.
- [ ] **Step 4:** Run `pnpm --filter @cinewright/core test`, then `pnpm lint && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): IR common definitions, project and delivery profile schemas"`.

## Task 2: Generated types (PR M1.6)

**Files:**
- Create: `core/scripts/gen-types.mjs`, `core/src/generated/ir.ts`, `core/py/src/cinewright_ir/models.py`, `core/test/generated.test.ts`, `core/py/tests/test_models.py`
- Modify: `core/package.json` (devDependency `json-schema-to-typescript@16.0.0`; scripts `gen:types`, `gen:check`), root `pyproject.toml` (dev group `datamodel-code-generator==0.96.0`), `core/py/pyproject.toml` (dependency `pydantic==2.14.3`), `.github/workflows/checks.yml` (job `types`), `.github/rulesets/main.json` (required check `types`), `core/py/src/cinewright_ir/__init__.py`

**Interfaces:**
- Consumes: `core/schema/*.schema.json`, the valid fixtures from Task 1.
- Produces: TS types exported from `@cinewright/core` (`Project`, `Deliverable`, `DeliveryProfile`, … one per `title`); Python models in `cinewright_ir.models` with the same class names; root script `pnpm gen:check`, which regenerates both outputs and fails on `git diff --exit-code core/src/generated core/py/src/cinewright_ir/models.py`.

- [ ] **Step 1: Check both generators against the Task 1 schemas.** Run each pinned generator once over `core/schema/` and read the output. Pass condition: cross-file relative `$ref`s into `$defs` resolve without a network request, each `x-authorable: field` node becomes `{ state: State; value?: T }` (TS) or a model with `state` and an optional `value` (Python), maps become string-keyed records or dicts of that wrapper, and `additionalProperties: false` produces no index signature (TS) and `extra="forbid"` (Python). **Fallback** if a generator resolves `$ref` against `$id` or cannot follow `$defs` across files: `gen-types.mjs` first bundles all schemas into one document (refs rewritten to `#/$defs/<file>__<name>`) and both generators read the bundle. Record which path was taken as a ruling. Flags to try for datamodel-code-generator: `--input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --target-python-version 3.13 --use-title-as-name --use-standard-collections --use-union-operator --field-constraints --extra-fields forbid --disable-timestamp` (confirm each at 0.96.0).
- [ ] **Step 2: Write the failing tests.**
  - `generated.test.ts` — "every valid fixture type-checks as its generated type and round-trips": for each valid fixture, `JSON.parse` → assign to the generated type in a typed helper (compile-time check) → `JSON.stringify` deep-equals the input.
  - `test_models.py` — "every valid fixture parses and serializes back": `Model.model_validate(data)` then `model_dump(mode="json", by_alias=True, exclude_unset=True) == data`; and "an invalid fixture with an unknown property is rejected" (`ValidationError`).
- [ ] **Step 3:** Run `pnpm --filter @cinewright/core test` and `uv run pytest core/py`. Expected: FAIL (no generated output).
- [ ] **Step 4:** Implement `gen-types.mjs` (TS output to `src/generated/ir.ts`, deterministic: no timestamps, stable order; then the Python generator over the same input). Export the types from `core/src/index.ts`. Add the `types` job to `checks.yml` (checkout, pnpm, node, uv as the other jobs; `pnpm install --frozen-lockfile && uv sync --locked && pnpm gen:check`) and add `types` to the ruleset's required checks.
- [ ] **Step 5:** Run `pnpm gen:check && pnpm typecheck && pnpm --filter @cinewright/core test && uv run pytest core/py && pnpm exec pyright && uv run cinewright-check-workflows .github/workflows .github/rulesets/main.json`. Expected: all pass. Then edit one schema description and confirm `pnpm gen:check` fails; revert.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat(core): generated TS and Python IR types with drift check"`.

## Task 3: Script and Cast (PR M1.1b)

**Files:**
- Create: `core/schema/{script,cast}.schema.json`, fixtures under `core/test/fixtures/schema/{script,cast}/`, including `cast/valid/spec-cast-example.json` with a README noting the stored-form mapping
- Modify: `core/schema/project.schema.json` (`script`, `cast`), `core/schema/README.md`, regenerated types

**Interfaces:**
- Consumes: Task 1's harness and lint; Task 2's `gen:check`.
- Produces: `Script`, `Beat`, `Line`, `CastMember` schemas and types; map handling for `lexicon` and `bindings`.

- [ ] **Step 1: Write fixtures first.** Valid: the spec's cast example in stored form (both members), a script with two beats and three lines, a lexicon with non-ASCII terms (`Zoë`, `東京`). Invalid, each with its `.errors.json`: a line without `id`; a `bindings` entry missing `state`; `pace_wpm` as a string; `role: "extra"`; a `lexicon` entry that wraps a wrapper (nested wrapper, `schema.type` or `schema.additionalProperties`).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: the new fixture cases FAIL.
- [ ] **Step 3:** Write the two schemas per the field map, wire them into `project.schema.json`, add their tables to the README, run `pnpm gen:types`.
- [ ] **Step 4:** Run `pnpm gen:check && pnpm --filter @cinewright/core test && uv run pytest core/py && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): script and cast schemas"`.

## Task 4: Sequence, Scene, Shot, Layer, Asset and the semantic validator (PR M1.1c)

**Files:**
- Create: `core/schema/{sequence,scene,shot,layer,asset}.schema.json`, fixtures for each, `core/test/fixtures/schema/sequence/valid/spec-scene-example.json` (+ README), `core/test/semantic.test.ts`
- Modify: `core/src/ir/semantic.ts`, `core/src/schema/validate.ts` (`DocumentKind` adds `sequence`), `core/schema/README.md`, regenerated types

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `validateProject(ir: InlinedIr, options?: { retiredIds?: ReadonlySet<string> }): ValidationError[]` — schema for the project and every sequence, then every semantic rule across the whole IR. `type InlinedIr` = the project document with each id in `sequences.value` replaced by that sequence's body (convention 11). This is the in-memory form every later task uses.

- [ ] **Step 1: Write the failing tests.**
  - Fixtures: the spec's scene example in stored form, inside a sequence, with the cast and script it references (including its out-of-scope `generative_footage` shot); a layer with token refs in `props` and anchors in `timing`.
  - `semantic.test.ts`, one case each, matching exact error lists: a duplicate id across kinds (`semantic.duplicate_id`); a scene `lines` entry with no such line (`semantic.dangling_ref`); `speaker` pointing at a shot (`semantic.ref_kind`); two deliverables whose profiles have different frame rates (`semantic.frame_rate_mismatch`); a deliverable naming a profile not in `profiles` (`semantic.unknown_profile`); a profile whose `hash` does not match the JCS hash of its `body` (`semantic.profile_hash`); an id in `retiredIds` (`semantic.id_reused`); an anchor with `point: "word"` and no `word` (`anchor.word_presence`).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Write the five schemas, extend the entity index to inlined sequences, and implement the semantic rules. Reference kinds come from the field map. The validator does not check v0.1 capability limits (M7.1). M1.1c lists style references among the references to resolve. A style pack id cannot resolve before packs exist (M2.1), so in M1 the validator checks only its shape (`schema.pattern`), and M2.1 adds `semantic.unknown_pack`. Record this as a ruling.
- [ ] **Step 4:** Run `pnpm gen:check && pnpm --filter @cinewright/core test && uv run pytest core/py && pnpm typecheck && pnpm lint`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): sequence, scene, shot, layer and asset schemas; semantic validator"`.

## Task 5: Project layout, canonical writer, hasher, CAS and `init` (PR M1.7)

**Files:**
- Create: `core/src/canonical/{stored,hash}.ts`, `core/src/time.ts`, `core/src/project/{layout,files,init}.ts`, `core/src/cas/cas.ts`, `core/src/store/log.ts` (append and read only), `core/test/fixtures/jcs/vectors.json`, `core/test/{canonical,cas,project}.test.ts`
- Create: `cli/src/{bin,args,output,exit-codes}.ts` (replacing the placeholder `bin.ts`), `cli/src/commands/init.ts`, `cli/test/init.test.ts`
- Modify: `core/package.json` (dependency `canonicalize@5.1.0`), `cli/package.json` (dependency `@cinewright/core: workspace:*`)

**Interfaces:**
- Consumes: `validateProject`, `InlinedIr`.
- Produces:
  - `toStoredForm(value: unknown): string` and `toHashForm(value: unknown): string` (throws on non-finite numbers); `sha256Hash(value: unknown): Hash` (over the hash form); `stateHash(ir: InlinedIr): Hash`.
  - `readProjectFiles(dir): Promise<InlinedIr>` and `writeProjectFiles(dir, ir): Promise<WrittenFile[]>` (splits sequences out; writes only changed files).
  - `initProject(dir, { id, title?, deliverables: [{ id, profilePath }] }): Promise<InitResult>` — validates each profile, copies `{ hash, body }` into `profiles`, sets `settings.propose_conversational_edits` to `{ value: true, state: "user" }`, writes the files, `.gitignore` (`.cinewright/`) and `log/patches.jsonl` with one `init` entry holding the full initial IR and its `state_hash`.
  - `Cas`: `put(bytes): Promise<Hash>` (write temp, fsync, rename), `get(hash): Promise<Uint8Array>` (re-hashes, throws `CasCorruptError` naming the hash), `has(hash)`.
  - `parseTime(input: number | string, fps: Rational): number` (integer frames; Review Focus 2).
  - Log entry types (extended in Task 6): `{ seq, kind: "init", time, session_id, author, ir, state_hash }`, each written as one hash-form line.
  - CLI `cinewright init <dir> --id <project_id> --deliverable <id>=<profile.json> [--deliverable …] [--json]`, which uses exit codes 0, 2 and 3.

- [ ] **Step 1: Write the failing tests.**
  - `canonical.test.ts`: "the hasher reproduces the RFC 8785 vectors" (the RFC's Appendix examples plus `vectors.json`: floats `1e21`, `1e-7`, `-0`, `0.1`, `5e-324`, non-ASCII keys, ` `, lone escapes); "the stored form sorts keys in JCS order", including `Zoë`, `東京`, emoji keys (Review Focus 1); "NaN and Infinity are rejected".
  - `project.test.ts`: "init creates a project that validates"; "load → save is byte-identical for every file" (also for a project with three sequences and non-ASCII text); "deleting `.cinewright/runs/` changes neither `stateHash` nor the files"; "the frame rate cannot change once the project exists": `initProject` with profiles of two rates fails with `semantic.frame_rate_mismatch`, and a patch setting a deliverable's `profile` to an id not in `profiles` fails with `semantic.unknown_profile`. Profiles are added only by `init` in M1, so every profile a project holds shares one rate. M5.3, which adds profiles later, must keep this rule for projects with timed entities.; time normalization cases at 30 and 30000/1001 (Review Focus 2).
  - `cas.test.ts`: put/get round trip; a flipped byte fails with an error naming the hash; a missing asset referenced by an entity fails naming that entity (through a `resolveAsset(ir, cas, assetId)` helper).
  - `cli/test/init.test.ts`: `cinewright init` with two fixture profiles exits 0 and writes `cinewright.json`; without `--deliverable` it exits 2.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement per Interfaces. The layout is `cinewright.json`, `sequences/<id>.json`, `log/patches.jsonl`, `log/decisions.jsonl`, `.cinewright/{cas,runs,txn}/`, `.gitignore`. Sequence file names come only from ids that passed the id pattern.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): project layout, canonical JSON, CAS and cinewright init"`.

## Task 6: Ops, revisions and the patch log (PR M1.4a)

**Files:**
- Create: `core/schema/{patch,log-entry}.schema.json`, `core/src/store/{store,lock,txn,patch,apply,snapshot,conflict}.ts`, `core/src/ir/paths.ts`, `core/test/store/{ops,atomic,load,replay,revert,time,ids}.test.ts`, `core/test/store/crash-child.ts`
- Modify: `core/src/store/log.ts`, regenerated types

**Interfaces:**
- Consumes: Task 5's files, hasher, log, `parseTime`; `validateProject`.
- Produces:
  - `Store.open(dir, options?: { sessionId?, now?: () => string, writeScopes?, gates? }): Promise<Store>` — takes the lock only while writing; rolls journals forward or back; verifies `state_hash` against the last applied entry.
  - `store.apply(patch: Patch): Promise<ApplyResult>` where `ApplyResult = { status: "applied", revision, stateHash } | { status: "pending", pendingId, reason } | { status: "rejected", errors: PatchError[] } | { status: "conflict", conflicts: Conflict[] }`.
  - `store.revert(revision: number, author: Author): Promise<ApplyResult>`; `store.ir(): InlinedIr`; `store.revision(): number`; `store.log(): LogEntry[]`.
  - `ProjectLoadError` with `{ file, entity, pointer }`, raised when files differ from the log's last `state_hash`.
  - Log entry kinds added: `applied` (`revision`, `base_revision`, `author`, `reason`, `ops`, `touched: [{ entity, path }]`, `before: Snapshot[]`, `state_hash`, `revert_of?`, `approved?`), `pending`, `approved` and `rejected` (written by Task 9). Decision entries go to `log/decisions.jsonl` as `{ revision, ops: [index], choice, citations, author, session_id, time }`.
  - In this task authorship is not enforced: every op applies and its state follows convention 10's author rule. Task 8 adds the gate.

- [ ] **Step 1: Write the failing tests.**
  - `ops.test.ts` — "every op applied then reverted restores the starting state_hash under a new revision", one case per op (`set`, `unset`, `insert`, `remove`, `move`, `lock`, `unlock`; `suggest` returns `pending` and writes no IR file), including insert of a sequence (new file) and remove of a sequence (file deleted); "a patch with one invalid op changes nothing" (bad path, unknown entity, `set` on an entity list, `path` inside a wrapped value, `patch.mixed_suggest`); "time inputs in ops are normalized" (`"18s"` → 540 at 30 fps).
  - `atomic.test.ts` — "a kill at any point leaves the old or the new revision". `crash-child.ts` applies a multi-file patch with `CINEWRIGHT_TEST_CRASH_AT=<step>` (a test hook in `txn.ts` that exits the process at each of the journal steps: before marker, after marker, after each rename, after log append); for every step, reopening yields either the old `state_hash` and revision or the new ones, never a mix.
  - `load.test.ts` — "a file edited outside the store fails to load naming the file and the changed entity" (edit a shot's `framing` in `sequences/x.json` → `ProjectLoadError { file: "sequences/x.json", entity: "<shot id>", pointer: "/framing" }`).
  - `replay.test.ts` — "replaying the log from an empty project reproduces the current state_hash" after a mixed series of 20 patches.
  - `revert.test.ts` — Review Focus 5.
  - `ids.test.ts` — Review Focus 4: inserting an entity with id `../x`, `a/b`, `CON` or `Shot1` is rejected and no file appears outside the project.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. The patch is validated against `patch.schema.json` and paths are resolved before any write. `insert` takes bare values and wraps every authorable field and nested list with the author's state, sets `origin`, and places the item after `after` (`null` = first, absent = last). `remove` and `move` address the item by `entity` with an empty path. Conflict detection is convention 11 over `touched` and ancestor removals and locks since `base_revision` (it is exercised fully in Task 7). The lock follows Decisions.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check && uv run pytest core/py`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): IR store with ops, revisions, journaled apply and patch log"`.

## Task 7: Concurrency and write scopes (PR M1.4b)

**Files:**
- Create: `core/src/store/scopes.ts`, `core/test/fixtures/write-scopes.test.json`, `core/test/store/{concurrency,scopes,lock}.test.ts`, `core/test/store/apply-child.ts`
- Modify: `core/src/store/{store,conflict}.ts`

**Interfaces:**
- Consumes: Task 6's store.
- Produces: `type WriteScopes = Record<string /* agent role */, { kinds: string[]; paths: string[] /* JSON Pointer patterns, `*` = one segment */ }>`. When `writeScopes` is passed to `Store.open`, an `agent` patch whose role is missing or whose op falls outside the scope is rejected with `scope.denied` naming the op index. Without `writeScopes`, as in the CLI in M1, there is no scope check. `Conflict = { entity, path, revision }`.

- [ ] **Step 1: Write the failing tests.**
  - `concurrency.test.ts` — two child processes (`apply-child.ts`) with the same `base_revision` on disjoint fields both apply (revisions n+1 and n+2); on the same field the later returns `conflict` listing `{ entity, path, revision }` and writes nothing; a patch whose base is older than an ancestor's removal or lock conflicts.
  - `scopes.test.ts` — a `shot_builder` patch inside its scope applies; one op on a scene field is rejected naming that op; an unknown role is rejected.
  - `lock.test.ts` — Review Focus 3: a lock file with a dead pid is taken over; a lock held by a live child makes `apply` fail after the timeout (set to 500 ms in the test) with an error naming the holder pid.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement scopes and finish the conflict paths.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): optimistic concurrency and role write scopes"`.

## Task 8: Authorship state rules (PR M1.2a)

**Files:**
- Create: `core/src/authorship/rules.ts`, `core/test/authorship/{table,properties}.test.ts`, `core/test/authorship/arbitraries.ts`
- Modify: `core/src/store/{apply,store}.ts` (the authorship gate before apply), `core/package.json` (devDependency `fast-check@4.10.2`)

**Interfaces:**
- Consumes: Tasks 6–7.
- Produces: `checkOp(ir: InlinedIr, op: ResolvedOp, author: Author, gates: ReadonlySet<string>): { ok: true } | { ok: false; kind: "blocked" | "forbidden"; rule: string }`. "blocked" (a field, list or item state stops it) makes the whole patch pending (convention 13, wired fully in Task 9; in this task the store returns `{ status: "pending", reason: "authorship_blocked" }` and logs a `pending` entry). "forbidden" (an op the author kind may never send, such as `lock` from an agent) rejects the patch (exit 3).

  The table:

  | Author | `set` | `unset` | list `insert`/`remove`/`move` | `lock`/`unlock` |
  | --- | --- | --- | --- | --- |
  | agent, job | `open`/`agent` → `agent`; `user`/`locked` blocked | `agent` → `open`; `open` no-op; `user`/`locked` blocked | allowed on `open`/`agent` lists (list becomes `agent`); `user`/`locked` lists blocked; removing a `user` item blocked | forbidden, except gate jobs: `lock` only |
  | user, session (when applying) | `open`/`agent`/`user` → `user`; `locked` → rejected `authorship.locked` | → `open`; `locked` → rejected | allowed unless the list or an ancestor is locked | allowed |

  Anything under an entity with `locked: true`, or under a locked ancestor, is blocked for agents and rejected for users, except `unlock` of that entity by a user.

- [ ] **Step 1: Write the failing tests.**
  - `table.test.ts` — one test per table cell, including entity lock, list lock and a `user` item (inserted by a user, or holding a `user` field) under an `agent` list.
  - `properties.test.ts` — fast-check, `numRuns: 1000` each, seed printed on failure, over generated IR instances (`arbitraries.ts`: random project trees with random states, `origin` and locks) and generated agent and job patches. Properties: (1) no applied agent or job patch changes the value or state of a `user` or `locked` field; (2) nor anything under a locked entity; (3) nor the membership or order of a `user` or `locked` list; (4) nor removes a `user` item; (5) every op outside the table is rejected or made pending, never applied.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement `rules.ts` and the gate in the store.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass. Read the property run counts in the output (5 × ≥ 1000).
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): authorship state rules with property tests"`.

## Task 9: Pending patches (PR M1.2b)

**Files:**
- Create: `core/src/store/pending.ts`, `core/test/store/pending.test.ts`
- Modify: `core/src/store/store.ts`

**Interfaces:**
- Consumes: Task 8's gate; `settings.propose_conversational_edits`.
- Produces: `store.pending(): PendingPatch[]`; `store.approve(pendingId, approver: Author /* user */): Promise<ApplyResult>`; `store.reject(pendingId, approver, reason?): Promise<void>`. A pending id is `p<n>`, where `n` counts `pending` entries from 1. Pending entries record `reason`: `proposed`, `session_propose_first`, `authorship_blocked` or `suggest`. An `approved` entry records the approver and is followed by the `applied` entry, in which every touched field takes `user` state. A `rejected` entry records the approver and reason.

- [ ] **Step 1: Write the failing tests** (`pending.test.ts`), one per M1.2b AC:
  - every authorship-blocked agent patch appears as a pending suggestion in the log;
  - a `session` patch in `propose` mode, and in `apply` mode with propose-first on, changes no file;
  - with propose-first off, a `session` `apply` applies directly with `user` state;
  - approving sets the touched fields to `user` and records the approver;
  - approving a pending patch whose fields changed after its base fails with a conflict and writes nothing;
  - rejecting records the rejection and changes nothing;
  - approving an id that was already approved or rejected fails.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): pending patches, propose-first and approvals"`.

## Task 10: Cascade resolver (PR M1.3)

**Files:**
- Create: `core/src/cascade/resolve.ts`, `core/test/cascade.test.ts`, `core/test/fixtures/cascade/{nested-overrides,per-aspect-layout,unresolved-token}/…`

**Interfaces:**
- Consumes: `InlinedIr`, the entity index.
- Produces: `type TokenTree` (plain nested JSON object; a pack's tokens, format owned by M2.1); `resolveEntity(ir, entityId, deliverableId, pack: TokenTree): Resolved` where `Resolved = { tokens: Record<path, { value, origin }>, fields: Record<pointer, { value, origin }> }`; `origin = { level: "pack" } | { level: "project" | "sequence" | "scene" | "shot" | "layer"; entity: string }`. Token refs inside resolved fields are replaced by their values. `layout` maps resolve to the variant for the deliverable's profile `aspect_class`. A missing variant is an error (`cascade.layout_variant_missing`, entity and aspect class) and never silently falls back. An unresolved token is an error naming the entity and field (`cascade.unresolved_token`).

- [ ] **Step 1: Write the failing tests.** For each fixture and each deliverable, the resolved value and origin of every token and of every token-bearing field deep-equal `expected.json` (generated once by hand-checking, then checked in); `unresolved-token` fails with the exact error.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement: walk from the project to the entity, layering `style.overrides` entries over the pack. Only `locked` cascades as a state (D25), and the resolver reports values, not states.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): cascade resolver with origins and per-aspect layouts"`.

## Task 11: Dependency graph and render keys (PR M1.5)

**Files:**
- Create: `core/src/graph/{deps,render-key}.ts`, `core/test/graph.test.ts`, `core/test/fixtures/graph/…`

**Interfaces:**
- Consumes: `resolveEntity`, `sha256Hash`.
- Produces:
  - `renderKey(ir, shotId, deliverableId, inputs: { pack: TokenTree; componentVersions: Record<string, string>; backendVersion: string; containerDigest: string }): Hash`. The hash covers the shot's resolved spec (states stripped; tokens limited to those the shot and its layers reference), the referenced asset hashes, the versions of the components it uses, the backend version, the container digest and the deliverable's profile hash.
  - `dependencyGraph(ir, inputs): Graph`, with node ids such as `line:<id>`, `take:<asset id>`, `anchors:<shot id>`, `duration:<shot id>`, `render:<shot id>@<deliverable id>`, `transition:<scene id>@<deliverable id>`, `mix@<deliverable id>`, `captions@<deliverable id>`, `assembly@<deliverable id>`, and planning nodes `plan:<scene id>`, `script`.
  - `dirtyNodes(before: InlinedIr, after: InlinedIr, inputs): Set<string>`.

- [ ] **Step 1: Write the failing tests.** Changing one shot's `framing` dirties exactly its `render:` nodes, the transition segments adjacent to it and `assembly@` per deliverable; changing a project-level token dirties every `render:` node whose shot uses that token and no `line:`, `take:` or `plan:` node; "the same inputs give the same key in any key order" (a fast-check property shuffling object key order, 1,000 runs).
- [ ] **Step 2:** Run `pnpm --filter @cinewright/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Versions and the digest are opaque strings here (real values arrive with M2–M3).
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(core): dependency graph and render keys"`.

## Task 12: Plugin manifest, loader, in-process interface and conformance kit (PR M1.8a)

**Files:**
- Create: `plugins/sdk-ts/schema/manifest.schema.json`, `plugins/sdk-ts/src/{manifest,loader,plugin,errors,kit}.ts`, `plugins/sdk-ts/test/{manifest,kit}.test.ts`, `plugins/sdk-ts/test/fixtures/stub-plugin/{manifest.json,index.ts,golden.json}`, `plugins/sdk-ts/README.md`
- Modify: `plugins/sdk-ts/package.json` (dependency `ajv@8.20.0`)

**Interfaces:**
- Produces:
  - Manifest fields: `schema_version`, `id`, `version`, `kind` (`llm` · `tts` · `music` · `sfx` · `image` · `video` · `lipsync` · `stt` · `stock` · `backend` · `critic` · `exporter`), `capabilities` (string list), `cost_model` (`{ unit, usd_per_unit }` or `{ unit: "free" }`), `latency_class` (`interactive` · `batch` · `offline`), `output_license` (required: `{ terms, commercial_use, attribution? }`), `secrets` (env var names), `runtime` (`{ kind: "in_process", entry }` or `{ kind: "subprocess", command: [string], cwd? }`, discriminated by `kind`), `concurrency` (`{ max_parallel }`), `rate_limits` (`[{ requests, per_seconds }]`).
  - `interface Plugin { init(ctx: PluginContext): Promise<void>; capabilities(): Promise<string[]>; call(req: PluginRequest, signal: AbortSignal): Promise<PluginResponse>; shutdown(): Promise<void> }`.
  - `PluginRequest = { id: string; method: string; params: unknown }`; `PluginResponse = { ok: true; result: unknown } | { ok: false; error: PluginError }`; `PluginError = { code: "invalid_request" | "unsupported" | "timeout" | "cancelled" | "rate_limited" | "provider_error" | "internal"; message: string; retryable: boolean; data?: unknown }`.
  - `loadPlugin(manifestPath): Promise<LoadedPlugin>` (validates the manifest; imports `entry` for `in_process`).
  - `runConformance(plugin: LoadedPlugin, golden: GoldenCase[]): Promise<ConformanceReport>` with the checks in the AC.

- [ ] **Step 1: Write the failing tests.** `manifest.test.ts`: a manifest without `output_license` is rejected with `schema.required`; an unknown `kind` is rejected. `kit.test.ts`: the stub passes every kit check; a stub variant whose `capabilities()` differs from its manifest fails the capability check; a golden request returns the expected result; a request with bad params returns a typed `invalid_request`; aborting a slow call (stub method `sleep`) returns `cancelled` within 1 s.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/plugin-sdk test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(plugin-sdk): manifest, loader, in-process interface and conformance kit"`.

## Task 13: Subprocess host and Python plugin SDK (PR M1.8b)

**Files:**
- Create: `plugins/sdk-ts/src/{rpc,host}.ts`, `plugins/sdk-ts/test/host.test.ts`, `plugins/sdk-py/src/cinewright_plugin_sdk/{rpc,plugin}.py`, `plugins/sdk-py/tests/{test_rpc.py,fixtures/stub_plugin/{manifest.json,plugin.py}}`
- Modify: `plugins/sdk-ts/src/loader.ts` (`subprocess` runtime)

**Interfaces:**
- Consumes: Task 12's interface and kit.
- Produces:
  - JSON-RPC 2.0 methods `initialize`, `capabilities`, `call`, `health`, `shutdown`, and the notifications `$/cancel` (`{ id }`) and `exit`.
  - `SubprocessPlugin implements Plugin`: spawns `runtime.command`; `health` must answer within 5 s at start; each `call` has a timeout (from `PluginContext`, default 60 s), after which the host sends `$/cancel`, waits 1 s, kills the process and returns `timeout`; `shutdown` sends `shutdown` then `exit`, then SIGTERM after 2 s and SIGKILL after 2 s more. The host tracks its children and kills them on `exit`, `SIGINT` and `SIGTERM`.
  - Python `class Plugin` (override `capabilities` and `call`; `cancelled()` for cooperative cancellation) and `serve(plugin)`, standard library only, which exits when stdin closes.

- [ ] **Step 1: Write the failing tests.** `host.test.ts`: the Python stub passes the same kit as a subprocess; a stub method that hangs is killed at the timeout and returns a typed `timeout`; a host process that exits normally leaves no child alive; a host process killed with SIGKILL leaves no child alive within 2 s (the child sees stdin close). `test_rpc.py`: framing round trip, unknown method returns JSON-RPC error `-32601`, malformed line returns `-32700`.
- [ ] **Step 2:** Run `pnpm --filter @cinewright/plugin-sdk test && uv run pytest plugins/sdk-py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && uv run pytest && uv run ruff check . && pnpm exec pyright`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(plugin-sdk): subprocess host over JSON-RPC and Python SDK"`.

## Task 14: `cinewright patch` and `cinewright show` (PR M1.9)

**Files:**
- Create: `cli/src/commands/{patch,show}.ts`, `cli/src/show/{view,diff}.ts`, `cli/README.md`, `cli/test/{patch,show,diff,reference}.test.ts`, `cli/test/fixtures/m1-reference/{build.sh,README.md,patches/*.json,project/…,golden/…}`
- Modify: `AGENTS.md` §3 invariant 2 (point to `cli/README.md` for the commands), `docs/HANDOFF.md` (how to edit a project)

**Interfaces:**
- Consumes: the whole store, `resolveEntity`.
- Produces:
  - `cinewright patch apply|propose [--file <patch.json> | -]` (the author comes from the patch, convention 10); `patch approve <pending_id>`, `patch reject <pending_id> [--reason <text>]` (author `user`); `patch list --pending`; `patch revert <revision>`.
  - `cinewright show [<id>] [--depth <n>] [--frames] [--resolved --pack <tokens.json>] [--json]`.
  - All commands: `--project <dir>` (default: search upward from the working directory for `cinewright.json`), `--json` (machine output: `{ status, revision?, state_hash?, pending_id?, errors?, conflicts? }`), exit codes as above.
  - Readable diff, one line per op: `~ <entity> <path>: <old> → <new>  [<state>]` for `set` and `unset`, `+ <entity> <path> after <id>: <new id>`, `- <entity>`, `> <entity> after <id>`, `lock <entity> <path>`, `unlock <entity> <path>`, `? <entity> <path>: <value>` for `suggest`; times shown in seconds unless `--frames`.
  - The readable view follows convention 14 and the spec's examples: entity id and kind first, every field with its state as a trailing `# state` comment, times in seconds, script lines inline in scenes, pending suggestions under their field as `# suggested (p3): <value>`, children one level deep by default.

- [ ] **Step 1: Write the reference build first.** `build.sh` runs only `cinewright init`, `cinewright patch apply` (and one `propose` + `approve`) and `cinewright show`, with `CINEWRIGHT_SESSION_ID=m1-reference` and `CINEWRIGHT_FIXED_TIME=2026-11-13T00:00:00Z`, to build the M1 reference project: the spec's scene and cast examples, a script, one sequence and the two fixture deliverables. Write the patch files by hand from the spec examples.
- [ ] **Step 2: Write the failing tests.**
  - `reference.test.ts`: running `build.sh` into a temp dir produces a tree byte-identical to `project/`, logs included.
  - `show.test.ts`: `show` output for the project, the scene, a shot and the cast matches `golden/*.txt`, including each field's state, and `--frames`, `--depth 2` and `--json` (equal to the stored form).
  - `diff.test.ts`: the readable diff of each reference patch matches `golden/diff-<n>.txt`.
  - `patch.test.ts`: every applied patch appears in the log with its author and, where approved, its approver; each exit code (2, 3, 4, 5, 6, 7) has one case; `patch list --pending --json` lists a blocked agent patch.
- [ ] **Step 3:** Run `pnpm --filter @cinewright/cli test`. Expected: FAIL.
- [ ] **Step 4:** Implement the commands, the view and the diff; generate `project/` and the golden files with the finished CLI, read every golden file by eye against the spec's examples, and check them in.
- [ ] **Step 5:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm gen:check && uv run pytest && pnpm exec pyright && uv run cinewright-check-boundaries .`. Expected: all pass.
- [ ] **Step 6: Record the agent trial.** Ask the maintainer whether to run it now. If yes, run a coding agent in a fresh temp directory, with only `cli/README.md` and a prose description of the reference project (in `cli/test/fixtures/m1-reference/README.md`), and keep its transcript. Attach to the PR: the commands it ran, whether `show` matches the reference project field by field, and any CLI or doc friction it hit. If the maintainer declines, say so in the PR.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(cli): cinewright patch and show"`.

---

## Done when (M1 AC map)

| M1 acceptance criterion | Proven by |
| --- | --- |
| M1.1a: valid and invalid fixtures per schema, exact error lists; meta-schema check in CI | Task 1 (`fixtures`, `meta` tests in the `ts` job) |
| M1.1b: as M1.1a; the spec's cast example validates | Task 3 |
| M1.1c: the spec's scene example validates; dangling reference, duplicate id, two frame rates fail with exact errors | Task 4 |
| M1.2a: property tests, ≥ 1,000 cases each, seed printed; the four protections; out-of-table transitions rejected | Task 8 |
| M1.2b: blocked patches pending; propose changes nothing; approve → `user` and approver; stale approve conflicts; reject records | Task 9 |
| M1.3: resolved values and origins match expected files per deliverable; unresolved token error | Task 10 |
| M1.4a: apply → revert per op; invalid op changes nothing; kill-safe; hand edit named; replay reproduces `state_hash` | Task 6 |
| M1.4b: disjoint patches both apply; overlapping later one conflicts with fields and revision; out-of-scope op named | Task 7 |
| M1.5: one shot dirties only its renders, adjacent transitions and assembly; a token dirties only shots using it; keys stable under key order | Task 11 |
| M1.6: drift fails CI; TS strict and Pyright pass; fixtures round-trip in both languages | Task 2 (`types` job) |
| M1.7: `init` validates; load → save byte-identical; RFC 8785 vectors; CAS errors name hash or entity; deleting `runs/` changes nothing | Task 5 |
| M1.8a: stub passes the kit in process; manifest without license terms rejected | Task 12 |
| M1.8b: Python stub passes the kit as a subprocess; hang killed at timeout; no child outlives the host | Task 13 |
| M1.9: reference project built only through the CLI, byte-identical; `show` and diff goldens; log has authors and approvals; agent trial attached | Task 14 |

## Execution notes

- PR order: Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14. Tasks 12 and 13 depend only on M0 and may move earlier if a schema PR waits on review. One task is one PR, merged on green.
- Each schema PR (Tasks 1, 3, 4) regenerates types and keeps `pnpm gen:check` green from Task 2 on.
- New npm packages may be newer than pnpm's `minimumReleaseAge`. If an install is refused, add an exact `minimumReleaseAgeExclude` entry for that version, as M0.2 did for HyperFrames, and note it in the PR.
- When the schema check in Task 2 Step 1 forces the bundling fallback, Tasks 3 and 4 inherit it without further rulings.
