# IR schemas

These JSON Schema files are the source of truth for the Cinewright IR (D4). TypeScript and Python types are generated from them (M1.6). The IR is written only by the IR store (D30, D40); these schemas describe what it writes.

## Dialect

JSON Schema 2020-12, limited to what both code generators handle (M1 convention 5):

- No `if`/`then`/`else`, `prefixItems`, `dependentSchemas`, `dependentRequired`, `unevaluatedItems`, `unevaluatedProperties`, `format`, `$dynamicRef` or `$dynamicAnchor`.
- `oneOf` only when every branch has the same property with a `const` value (a discriminator).
- Property names are `snake_case` and never a Python keyword or TypeScript reserved word.
- Every file, every `$defs` entry and every entity schema has a `title`; generated type names come from it.
- `$id` is `https://cinewright.invalid/ir/0/<file>`. The `.invalid` domain never resolves, so no tool can fetch a schema over the network. Cross-file `$ref`s are relative (`common.schema.json#/$defs/id`).

`core/test/schema/lint.test.ts` enforces these rules.

## Generated types

`pnpm gen:types` regenerates `core/src/generated/ir.ts` (json-schema-to-typescript), `core/py/src/cinewright_ir/models.py` (datamodel-code-generator, Pydantic v2) and `core/test/generated/fixtures.ts`, which holds every valid fixture typed with `satisfies`, so `pnpm typecheck` proves the fixtures fit the TypeScript types. The outputs are committed. CI's `types` job runs `pnpm gen:check` and fails when they differ from what the schemas generate. Run `pnpm gen:types` after any schema change and commit the result. A new fixture directory needs an entry in `FIXTURE_TYPES` in `core/scripts/gen-types.mjs`.

## Annotations

| Keyword | On | Meaning |
| --- | --- | --- |
| `x-entity` | an entity's object schema | The entity kind (`project`, `deliverable`, …). Every entity has `id`, `origin` and optional `locked`. |
| `x-authorable: field` | a property | An authorable field, stored as a wrapper (below). |
| `x-authorable: list` | a property | An entity list: a wrapper whose `value` is an array of entities, or of ids for `project.sequences`. Its state governs membership and order only (convention 7). |
| `x-authorable: map` | a property or `$defs` entry | A map with one wrapper per entry (convention 7). |
| `x-ref` | an id property | The kind (or list of kinds) the id must resolve to. Checked by the semantic validator (M1.1c). |

## Wrappers and entities

An authorable field is `{ "state": State, "value": T }` (M1 convention 6):

- An `open` field has no `value`. Any other state requires one (rule `wrapper.value_presence`).
- A wrapped value holds no nested wrappers. The only exception is an entity list, whose items keep their own field states.
- Every authorable field is always present. An unset field is `{ "state": "open" }`, so each project state has exactly one stored form.

Every entity carries three plain properties:

| Property | Meaning |
| --- | --- |
| `id` | Unique across all entity kinds in a project; never reused (convention 9). |
| `origin` | `user` or `agent`, set by the store on insert. It decides which items count as `user` items (convention 13). |
| `locked` | `true` only when the whole entity and its subtree are locked (convention 8). |

## Authorable fields

### Project (`project.schema.json`, `cinewright.json`)

| Field | Kind | Value |
| --- | --- | --- |
| `title` | field | string, 1–200 characters |
| `brief` | field | string, up to 20,000 characters |
| `autonomy` | field | `auto` · `guided` · `directed` · `manual` |
| `budget` | field | `{ currency: "USD", cap: number > 0 }` |
| `policies` | field | `{ require_commercial_license: boolean }` |
| `settings.propose_conversational_edits` | field | boolean (D25; on by default) |
| `style.pack` | field | pack id |
| `style.overrides` | map | token path → token value |
| `deliverables` | list | Deliverable |
| `sequences` | list | sequence ids, in order; each body is `sequences/<id>.json` |
| `cast` | list | CastMember |
| `assets` | list | Asset |

Plain: `id`, `origin`, `locked`, `schema_version` (`1`), `script` (the Script entity), `profiles` (profile id → `{ hash, body }`, written only by `init`; convention 16).

### Deliverable (`project.schema.json#/$defs/deliverable`)

| Field | Kind | Value |
| --- | --- | --- |
| `profile` | field | a profile id present in `project.profiles` |
| `label` | field | string, 1–200 characters |
| `burn_in_captions` | field | boolean |

### Script (`script.schema.json`; `project.script`)

| Entity | Field | Kind | Value |
| --- | --- | --- | --- |
| Script | `beats` | list | Beat |
| Beat | `summary` | field | string |
| Beat | `lines` | list | Line |
| Line | `text` | field | string, 1–2,000 characters |
| Line | `direction` | field | string (delivery direction, such as audio tags) |
| Line | `speaker` | field | id of a cast member (`x-ref: cast_member`) |
| Line | `on_screen` | field | boolean: the speaker is visible |
| Line | `lipsync` | field | boolean |
| Line | `on_screen_text` | field | string shown on screen with the line |

### CastMember (`cast.schema.json`; items of `project.cast`)

| Field | Kind | Value |
| --- | --- | --- |
| `role` | field | `narrator` · `character` (v0.1 casts only a narrator; checked at intake, M7.1) |
| `display_name` | field | string |
| `voice.description` | field | `{ language?, timbre?, accent?, text? }` (provider-neutral, D29) |
| `voice.lexicon` | map | term → pronunciation; any Unicode term |
| `voice.bindings` | map | provider id → `{ voice_id?, voice?, model?, settings? }` |
| `performance.baseline` | field | string |
| `performance.pace_wpm` | field | integer, 60–300 |
| `performance.tics` | field | list of strings |
| `on_screen` | field | boolean |
| `visual` | field | `{ sheet: [asset id], wardrobe?, style? }` |
| `consent` | field | `{ synthetic: boolean, record?: asset id }` (D18) |

Stored-form mapping of the spec's cast example (`core/test/fixtures/schema/cast/valid/spec-*.json`):
- `performance.pronunciations` becomes `voice.lexicon` (D29).
- `visual.sheet` paths become asset ids.
- Fields the example leaves out are `open`.

### Sequence, Scene, Shot, Layer (`sequence.schema.json`, `scene.schema.json`, `shot.schema.json`, `layer.schema.json`)

Each sequence is stored as `sequences/<id>.json` (D40). Every level from Sequence down has a plain `style` container whose `overrides` is a map of token path → token value (`style.schema.json`); only the project chooses a pack.

| Entity | Field | Kind | Value |
| --- | --- | --- | --- |
| Sequence | `title` | field | string |
| Sequence | `mood` | field | list of strings |
| Sequence | `music_bed` | field | string |
| Sequence | `scenes` | list | Scene |
| Scene | `intent` | field | string |
| Scene | `duration` | field | `{ target: frames, flex: 0–1, sync: voiceover · music · fixed }` |
| Scene | `mood` | field | list of strings |
| Scene | `cast` | field | list of cast member ids |
| Scene | `lines` | field | list of line ids, in order (D26) |
| Scene | `transition_out` | field | `{ type: cut · cross_dissolve · wipe · match_cut, to?: scene id, duration?: frames, on? }` |
| Scene | `sound` | field | `{ music_cue?, sfx: [string], duck_under_vo_db?: ≤ 0 }` |
| Scene | `gates` | field | list of `script` · `storyboard` · `animatic` · `final` |
| Scene | `shots` | list | Shot |
| Shot | `type` | field | `motion_graphics` · `generative_footage` · `stock` · `three_d` · `live_action` (what v0.1 renders is checked at intake, M7.1) |
| Shot | `backend` | field | string |
| Shot | `framing` | field | string |
| Shot | `subject` | field | cast member id |
| Shot | `camera` | field | `{ move, ease?: token value, amount? }` |
| Shot | `duration` | field | frames |
| Shot | `anchors` | field | `{ start: anchor, end?: anchor }` |
| Shot | `references` | field | list of asset or cast member ids |
| Shot | `layout` | map | aspect class → `{ template }` (D28) |
| Shot | `layers` | list | Layer |
| Layer | `component` | field | component id (D31) |
| Layer | `motion` | field | list of `{ preset, params? }` |
| Layer | `timing` | field | `{ enter: anchor, exit?: anchor }` |
| Layer | `props` | map | prop name → any JSON value; `{ "token": path }` is a token reference |
| Layer | `layout` | map | aspect class → `{ region }` |

An anchor (convention 15) is `{ line, point: start · end · word, word?, offset }`, where `offset` is in frames.

### Asset (`asset.schema.json`; items of `project.assets`)

Every asset field is measured data, so none is authorable; only membership of `project.assets` is. Fields: `hash`, `media_type`, `bytes`, `role` (`take` · `music` · `sfx` · `image` · `video` · `font` · `composition` · `reference` · `consent` · `other`), `line` (takes only), `provenance` (`{ provider, model?, plan_tier?, request_hash? }`), `license`, `words` (takes only: `[{ text, start, end }]` in samples).

Stored-form mapping of the spec's scene example (`core/test/fixtures/schema/sequence/valid/spec-scene-example.json`, 30 fps):
- `duration.target` 18 s becomes 540 frames.
- `dialogue` becomes `lines` (ids) plus the Line entities in the script.
- `elements` becomes one Layer per component.
- `refs: [cast.dr_lin.sheet]` becomes `references: ["dr_lin", "dr_lin_sheet_front"]`.
- `camera.ease: style.motion.ease_out_expo` becomes `{ "token": "motion.ease_out_expo" }`.
- `amount: 6%` becomes `0.06`.
- `style.inherit: pack.editorial` becomes the project's `style.pack`, because only the project chooses a pack.
- `to: s04` points at a minimal scene `s04`, added so the reference resolves.

### DeliveryProfile (`delivery-profile.schema.json`)

A data file, not an entity, so it has no wrappers. It holds `schema_version`, `id`, `name`, `frame_rate` (rational), `sample_rate`, `width`, `height`, `aspect_class`, `safe_zones` (`action` and `title` insets as fractions), `loudness` (`integrated_lufs`, `true_peak_dbtp`, `tolerance_lu`) and `captions` (`max_chars_per_line`, `max_lines`, `min_display_frames`).

## Validation errors

Each error is `{ "entity", "pointer", "rule" }`:
- `entity` is the id of the nearest enclosing entity, or `null`.
- `pointer` is a JSON Pointer relative to that entity.
- `rule` is the error code.

Errors are sorted by entity, then pointer, then rule. For a missing or unexpected property, the pointer names that property.

| Rule | Meaning |
| --- | --- |
| `schema.<keyword>` | A JSON Schema keyword failed (`schema.required`, `schema.additionalProperties`, `schema.pattern`, `schema.enum`, `schema.minimum`, `schema.propertyNames`, …). |
| `wrapper.value_presence` | A wrapper has a `value` while `open`, or none while not `open`. |
| `anchor.word_presence` | An anchor has `word` without `point: "word"`, or the reverse. |
| `semantic.duplicate_id` | Two entities share an id (across all kinds). |
| `semantic.dangling_ref` | An `x-ref` id names no entity. |
| `semantic.ref_kind` | An `x-ref` id names an entity of another kind. |
| `semantic.id_reused` | An id that was removed earlier is used again (convention 9). |
| `semantic.unknown_profile` | A deliverable names a profile that is not in `project.profiles`. |
| `semantic.profile_hash` | A profile copy's `hash` is not the hash of its `body` (convention 16). |
| `semantic.frame_rate_mismatch` | The deliverables' profiles have different frame rates (D27). |

`validateDocument(kind, doc)` checks one document: schema, wrappers and anchors. `validateProject(ir, { retiredIds })` checks the whole inlined IR, including every rule above.

## Patches and the patch log

`patch.schema.json` is the wire format every IR write uses (convention 10). Its `author`, `op` and `decision` definitions live in `common.schema.json`, because the log references them too.

- **Bare values:** values are bare. The store wraps them, sets each state from the author (`user` for users and sessions, `agent` for agents and jobs), and fills every field an inserted entity does not give as `open`.
- **Paths:** a path points at an authorable field, a map entry or an entity list, through plain containers only. It never points inside a wrapped value.
- **Items:** list items are addressed by id. `remove` and `move` take the item as `entity`. `move` stays within one list.
- **Times:** a field that holds frames also accepts `"18s"`, `"1500ms"` or `"HH:MM:SS:FF"`, normalized when the op applies.
- **Suggest:** a patch is all `suggest` ops or none.
- **Locks:** `lock` needs a value: locking an `open` field is refused. `unlock` returns a field to `user`. An entity lock is stored as `locked: true` on the entity.

`log-entry.schema.json` describes one line of `log/patches.jsonl`, written in the hash form. Its root `oneOf` references the entry kinds in `$defs` (datamodel-code-generator cannot emit a single module for a root-level `oneOf` with inline branches).

| Entry | Written when | Records |
| --- | --- | --- |
| `init` | `cinewright init` | Revision 0 and the full IR. |
| `applied` | A patch or revert creates a new revision. | `before` snapshots of every node it changed, `touched`, `retired` (removed ids) and `restored` (ids a revert brought back). |
| `pending` | A patch is stored instead of applied: a proposal, a suggestion, or (from M1.2a) an authorship block. | The patch, a `pending_id` and a `reason_code`. |
| `approved` / `rejected` | The user decides on a pending patch (M1.2b). | The pending id. |

Every entry records `time`, `session_id` and the asserted `author` (D41). A revert is a new revision whose `revert_of` names its target; replaying the log re-applies the target's `before` snapshots. On open, the store:
1. finishes or discards an interrupted journal (`.cinewright/txn/`);
2. compares the files' `state_hash` with the last applied entry;
3. checks that every file is in the stored form.

A file changed outside the store fails to load, naming the file, the entity and the field.
