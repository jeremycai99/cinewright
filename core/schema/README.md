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

Plain: `id`, `origin`, `locked`, `schema_version` (`1`), `script` (the Script entity), `profiles` (profile id → `{ hash, body }`, written only by `init`; convention 16), and `packs` (pack id → `{ version, hash }`, written only by `init --pack` and `cinewright pack pin`; M3.1a). A pin's `hash` is the pack's content hash: `pack.json`, `tokens.json`, `layouts.json`, `rules.md` and its declared fonts, so a README edit or a stray file never breaks it. Compiling resolves `style.pack` against its pin and fails with `pack.unset`, `pack.unpinned`, `pack.not_found` or `pack.pin_mismatch` (naming the pinned and found versions).

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
- `camera.ease: style.motion.ease_out_expo` becomes `{ "token": "motion.ease.enter" }`: token paths come from the core vocabulary (M2.1a, `pack/README.md`).
- `amount: 6%` becomes `0.06`.
- `style.inherit: pack.editorial` becomes the project's `style.pack`, because only the project chooses a pack.
- `to: s04` points at a minimal scene `s04`, added so the reference resolves.

### TimingTable (`timing.schema.json`)

Derived data, not an entity (M3.1a): `fps`, and `lines` keyed by script line id, each `{ start, end, words: [{ start, end }] }` in frames on its sequence's timeline. Narration writes it from takes (M4.2); until then a fixture or `--timing <file>` supplies it. `resolveAnchor` turns an anchor into a frame (`timing.unknown_line`, `timing.unknown_word`). `shotSpan` gives a shot's frames: from `anchors.start` to `anchors.end`, or after its `duration`, or to the next shot's start in the sequence (`timing.unknown_span` when none applies). `layerTiming` gives a layer's entrance and end relative to its shot, the whole shot when it has no timing; an exit after the shot's end ends the layer at the cut (exits are written before the takes exist), and `timing.outside_shot` is raised when the layer enters before the shot starts or not before it ends.

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
| `semantic.unknown_token` | A style override path, or the path in a `{ "token": … }` reference anywhere in a value, is not in the token vocabulary (`pack/README.md`) and not under `ext.` (M2.1a). |
| `semantic.token_type` | A literal or reference in a style override, or in a field marked `x-token-type` (shot `camera.ease`), does not fit that token's type. A reference is checked by the type of the path it points to. |
| `semantic.token_bounds` | A literal is outside its token's bounds or allowed values (`contrast.text_min: 3`). |
| `semantic.unknown_template` | A shot's layout template is neither a core template nor `ext_*` (M2.1b, `pack/README.md`). |
| `semantic.unknown_region` | A layer's region is not one of its shot's core template's regions for that aspect class. |

`validateDocument(kind, doc)` checks one document: schema, wrappers and anchors. `validateProject(ir, { retiredIds })` checks the whole inlined IR, including every rule above. `explainProject` returns the same errors with a `message` on each schema error saying what was expected (the type, the allowed values, the missing field or the allowed fields); the store puts these messages on patch errors.

`describeKind(kind)` lists every authorable path of an entity kind with its type, allowed values and nested keys, generated from these schemas; `cinewright schema <kind>` prints it.

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
| `approve_failed` | An approval fails; the patch stays pending. | The pending id, the revision it was tried at, and its `conflicts` or `errors`. |
| `pinned` | `cinewright pack pin` (M3.1a). | A new revision that sets `packs.<pack>` to the `version` and `hash` it records, and changes nothing else. |

Every entry records `time`, `session_id` and the asserted `author` (D41). A revert is a new revision whose `revert_of` names its target; replaying the log re-applies the target's `before` snapshots. A revert restores a list of entities by membership and order only: items that still exist keep their current bodies, so a later edit to a sibling survives, and only items the target removed come back from the snapshot (M2.5a, audit F1). Such reverts carry `revert_lists: "membership"`; reverts recorded earlier lack it and replay with the old whole-list restore, so their state hashes still reproduce. A revert conflicts when a later revision changed the same list, or edited an entity the revert would delete. On open, the store:
1. finishes or discards an interrupted journal (`.cinewright/txn/`);
2. compares the files' `state_hash` with the last `init`, `applied` or `pinned` entry;
3. checks that every file is in the stored form.

A file changed outside the store fails to load, naming the file, the entity and the field.

## Authorship (D25, M1.2a)

The store checks every op against the author's rights before it applies anything.

| Author | `set` / `unset` a field or map entry | `insert` / `remove` / `move` in a list | `lock` / `unlock` |
| --- | --- | --- | --- |
| agent, job | `open` or `agent` → `agent`; `unset` → `open`. On `user` or `locked`: **blocked**. | Allowed on an `open` or `agent` list (it becomes `agent`). A `user` or `locked` list: **blocked**. Removing a `user` item: **blocked**. | **Rejected**, except a gate job (`gate.script`, `gate.storyboard`, `gate.final`) may `lock`. |
| user, session | `open`, `agent` or `user` → `user`. On `locked`: **rejected** (unlock first). | Allowed unless the list or an ancestor is locked. The list becomes `user`. | Allowed |

- **Blocked:** the whole patch is stored as a pending suggestion (convention 13), with the blocked ops and their rules.
- **Rejected:** nothing is stored.
- **Entity locks:** anything under an entity with `locked: true`, or under a locked ancestor, is blocked for agents and rejected for users. The exception is a user's `unlock` of that entity.
- **`user` items:** an item a user inserted, or one holding a `user` or `locked` field or lock anywhere in its subtree.
- **Conflicts come first:** a stale patch reports its conflict before any authorship verdict.
- **Reverts** are for users only, and agent harnesses never run `patch revert` without asking the user (D41).

Rule codes:
- `authorship.user_field`, `authorship.locked_field`, `authorship.user_list`, `authorship.locked_list`, `authorship.user_item` and `authorship.locked_entity` (blocked);
- `authorship.locked` and `authorship.forbidden_op` (rejected).

`core/test/authorship/properties.test.ts` checks the four protections with 1,000 generated cases each.

## Pending patches (D25, M1.2b)

A patch is stored as `pending` instead of applied when:
- it proposes (`mode: "propose"`);
- it is a `session` patch in `apply` mode while `settings.propose_conversational_edits` is on (the default; an `open` setting counts as on);
- it is all `suggest` ops;
- authorship blocks one of its ops.

Before it is stored, a patch is checked as its approval would apply it: suggestions as `set`, authored by the approving user, against the current IR. Every check `apply` runs applies (paths, wrapping, times, conflicts, `validateProject`) except authorship, because a block is what pending is for. An invalid or stale patch is rejected or reported as a conflict, and nothing is stored.

Then `approve(id, user)` applies it as the approving user, so every field it touches becomes `user`. A suggestion applies as `set`. The approval writes an `approved` entry and the applied revision in one transaction. It fails with a conflict when a revision after the patch's base touched the same nodes, and it is rejected when the project changed so the patch no longer applies (a lock, a removed reference). A failed approval decides nothing: the patch stays pending and an `approve_failed` entry records the failure (`Store.approvalFailure(id)` returns the last one). The user can then rebase it as a new patch, fix what blocks it and approve again, or reject it. `reject(id, user, note?)` records the decision and changes nothing. Only a user approves or rejects, and a decided patch cannot be decided again (`pending.decided`).

## Cascade (M1.3)

`resolveEntity(ir, entityId, deliverableId, pack)` resolves the style cascade for a project, sequence, scene, shot or layer:

- **`tokens`:** every token path, with its value and origin. The origin is `{ level: "pack" }` or `{ level, entity }` for the project, sequence, scene, shot or layer whose `style.overrides` set it. Each level overrides the one above. A token that refers to another (`{ "token": path }`) takes the final value, and its origin is where it was defined.
- **`fields`:** the entity's own token-bearing fields, with references replaced by values and the origin of every token each one used. Also its `layout` variant for the deliverable's aspect class (D28).
- **Errors** (`CascadeError`, each naming the entity and field):
  - a reference to a token nobody defines: `cascade.unresolved_token`;
  - a cycle: `cascade.token_cycle`;
  - a layout with variants but none for the deliverable's aspect class: `cascade.layout_variant_missing`. There is no silent fallback.

Only values cascade. Authorship states do not, except that `locked` freezes a subtree (D25). Pack tokens are a plain token tree until the pack format exists (M2.1).

## Render keys and the dependency graph (M1.5)

`renderKey(ir, shotId, deliverableId, inputs)` hashes what a shot renders from:
- its resolved spec: states, `origin` and `locked` stripped; tokens resolved; the layout variant picked; its layers included;
- the hashes of assets it names;
- the versions of the components its layers use;
- the backend version, the container digest and the deliverable's profile hash.

Locking or approving a field never changes the key. Key order never matters.

`dependencyGraph(ir)` links, per deliverable: `line:` → `take:` → `anchors:` → `duration:` → `render:<shot>@<d>` and the adjacent `transition:<scene>@<d>` segment → `mix@<d>` → `captions@<d>` → `assembly@<d>`.
- Only `cross_dissolve` and `wipe` render as segments (D34).
- A segment depends on the last shot of its scene and the first shot of the next.
- Planning nodes (`script`, `plan:<scene>`) sit beside the chain.

`dirtyNodes(before, after, inputs)` returns the nodes whose own inputs changed, plus everything downstream of them.

**Render key v1 (M3.2b, audit F3).** The M1.5 key sees only what the IR states, so it misses tokens a component reads implicitly, region geometry, fonts and component code. `renderKeyV1({ compile, renderer })` hashes the backend's compile inputs (mount spec, root CSS, font, runtime and asset hashes, compiler version, profile hash, pack content hash) and the renderer (image content digest, HyperFrames version, render settings). A pack's README never enters it. `inputs.renderKey`, when given, replaces the M1.5 key for `render:` nodes: the engine passes the backend's `shotRenderKey`, so dirty sets follow v1 keys while core stays free of the backend.
