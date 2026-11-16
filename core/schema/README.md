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
