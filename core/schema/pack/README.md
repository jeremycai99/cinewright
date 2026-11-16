# Style pack format (v0)

A style pack is a design system for motion: tokens, layout templates and cited rules (D39; `docs/DESIGN_SPEC.md` "Style system"). Packs are plain files, so they diff in git. Taste lives only in packs (`AGENTS.md` §2.1); core code and components read tokens and never carry design values.

These schemas are the source of truth for the format. `$id`s are under `https://cinewright.invalid/pack/0/`; tools read them from this folder, never over the network.

## Files

A pack is a folder `<id>/` holding:

| File | Holds |
| --- | --- |
| `pack.json` | The manifest (`pack.schema.json`): `schema_version`, `id`, `name`, `version` (semver), `description`, `license`, `aspect_classes`, `fonts`, `retired_rules`. `extends` is reserved: pack composition comes after v0.1, and a pack that sets it is rejected. |
| `tokens.json` | Every core token (`tokens.schema.json`), plus pack-specific tokens under `ext`. |
| `rules.md` | The pack's rules, each with a stable id. |
| `fonts/` | Every font the tokens name, plus its licence text. Each font's `sha256`, `source` and `license` are recorded in `pack.json`. Renders load fonts only from here. |
| `README.md` | What the pack is for. |

A pack's example frames are its component specimens rendered on demand (`pnpm specimens`, M2.4b). They are never committed.

`loadPack(id, searchPath)` (`@cinewright/core`) finds a pack on the search path, so the first folder that holds `<id>/pack.json` wins. The CLI searches the project's `packs/`, then the first-party `packs/`. `Pack.hash` is the `sha256:` of the JCS form of `{ <path>: <sha256 of file> }` over every file in the folder, dotfiles excepted.

## Tokens

The token tree is the one M1's cascade resolves. A leaf is one of:

- a literal;
- a reference `{ "token": "<path>" }`;
- in packs only, `{ "by_aspect": { "<aspect class>": literal or reference } }`, which must cover every aspect class in `aspect_classes`.

Style overrides in the IR set one value for every aspect class.

**Vocabulary.** `tokens.schema.json` lists every core path. Its annotations are:
- `x-token-type`: the path's type;
- `x-minimum` and `x-maximum`: bounds;
- `x-enum`: allowed values.

`cinewright schema tokens` prints them. Every pack defines every core path. `ext.*` is free-form and untyped, for pack-specific components; any other path is an error.

**Types.** A reference is checked by the type of the path it points to, without being resolved, so `type.size.body: { "token": "palette.ink" }` fails. A `number` path may also point to an `integer` one.

| Type | Literal |
| --- | --- |
| `color` | `#RRGGBB` or `#RRGGBBAA`, uppercase hex |
| `dimension` | A number ≥ 0: percent of the frame's shorter side. Emitted as px (M2.4a). |
| `duration` | Whole milliseconds ≥ 0 |
| `easing` | `cubic-bezier(x1, y1, x2, y2)` with x1 and x2 in [0, 1], or `linear` |
| `font_family` | A family declared in the pack's `fonts` |
| `font_weight` | 100–900 in steps of 100 |
| `number`, `integer`, `boolean`, `string` | As in JSON, within any `x-minimum`/`x-maximum` |
| `enum` | One of `x-enum` |

The core paths by group (`cinewright schema tokens` has the full list):

| Group | Paths |
| --- | --- |
| `palette` | `bg`, `surface`, `ink`, `ink_muted`, `accent`, `on_accent`, `line`, `data.1`–`data.6` |
| `contrast` | `text_min` (≥ 4.5), `large_text_min` (≥ 3), `graphic_min` (≥ 3). These are the WCAG AA floors; packs may raise them, never lower them. |
| `type` | `family.*`, `weight.*`, `size.caption` … `size.display`, `leading.*`, `tracking.*`, `transform.display` |
| `layout` | `margin`, `gutter`, `columns`, `rows`, `radius`, `stroke` |
| `density` | `max_lines_title`, `max_bullets`, `max_words_bullet`, `min_text_size`, `hold_per_word`, `min_hold` |
| `motion` | `ease.*`, `duration.xs` … `duration.xl`, `stagger`, `distance`, `entrance`, `exit`, `text_reveal`, `preset.<name>.enabled` |
| `camera` | `ken_burns.scale`, `ken_burns.ease` |
| `transition` | `default`, `cross_dissolve.*`, `wipe.*` |
| `sound` | `music.*`, `sfx.*`, `duck.*`, `bus.*`. Loudness targets belong to delivery profiles, not packs. |

## Rules

`rules.md` uses level-2 headings to group rules by domain. Each rule is a level-3 heading ``### `<rule id>` <title>`` followed by its prose, up to the next heading.
- **Rule ids** match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$` and are unique in the pack.
- **Citations:** a decision-log entry cites a rule as `pack:<pack id>@<version>#<rule id>` (`citation()`).
- **Removing a rule:** its id moves to `retired_rules`, so old citations still resolve, and it is never reused.

## Errors

`loadPack` throws `PackError` listing every problem as `{ pack, file, pointer, rule }`. The pointer is a JSON Pointer into the file, or `/<line>` in `rules.md`. Problems are sorted by those four fields.

| Rule | Meaning |
| --- | --- |
| `pack.invalid_id`, `pack.not_found` | The id is malformed, or no folder on the search path holds `<id>/pack.json`. |
| `pack.missing_file`, `pack.invalid_json` | A pack file, or a font it names, is missing or is not JSON. |
| `pack.schema.<keyword>` | `pack.json` or `tokens.json` fails its schema: a missing core path is `required`, an unknown one is `additionalProperties`. |
| `pack.extends_reserved` | `pack.json` sets `extends`. |
| `pack.font_hash` | A font file's hash differs from `pack.json`. |
| `pack.unknown_font` | A `font_family` token names a family the pack does not ship. |
| `pack.token_type` | A literal does not fit its path's type, or a reference points to a path of another type. |
| `pack.token_bounds` | A literal is outside its bounds or allowed values. |
| `pack.unresolved_token` | A reference names a path that is neither in the vocabulary nor defined under `ext`. |
| `pack.token_cycle` | References form a cycle; every path on it is reported. |
| `pack.aspect_missing` | A `by_aspect` leaf lacks one of the pack's aspect classes; the pointer ends in that class. |
| `pack.rule_id`, `pack.rule_duplicate`, `pack.rule_retired` | A rule heading lacks a valid id, repeats one, or reuses a retired one. |

Resolving tokens has errors of its own:
- **Unsupported aspect class:** `resolvePackTokens(pack, aspect)`, or `resolveEntity` with `{ aspectClasses }`, throws `CascadeError` with `pack.aspect_unsupported` for an aspect class the pack does not declare.
- **Bad resolved values:** `checkResolved(tokens)` reports values that fail their type or bounds after the cascade, as `cascade.token_type` or `cascade.token_bounds`, naming the entity whose override set them.
