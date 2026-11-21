# cinewright CLI

`cinewright` is how people and agents (Claude Code, Codex and others) create and edit a project. Every IR write goes through the IR store: never edit `cinewright.json` or `sequences/*.json` by hand (D25, D40). A file changed outside the store makes the project fail to load (exit 6).

## Commands

```
cinewright init <dir> --id <project_id> --deliverable <id>=<profile name or path> [--deliverable …] [--pack <id>] [--title <text>] [--json]
cinewright patch apply   --file <patch.json> [--project <dir>] [--frames] [--json]
cinewright patch propose --file <patch.json> [--project <dir>] [--frames] [--json]
cinewright patch approve <pending_id> [--project <dir>] [--json]
cinewright patch reject  <pending_id> [--reason <text>] [--project <dir>] [--json]
cinewright patch list --pending [--project <dir>] [--json]
cinewright patch revert <revision> [--project <dir>] [--json]
cinewright show [<id>] [--depth <n>] [--frames] [--resolved --pack <tokens.json> [--deliverable <id>]] [--json] [--project <dir>]
cinewright status [--project <dir>] [--json]
cinewright schema [<kind> | tokens [--json]]
cinewright components [<id>] [--json]
cinewright pack pin <pack_id> [--project <dir>] [--json]
cinewright compile <shot_id> --deliverable <id> [--timing <timing.json>] --out <dir> [--project <dir>] [--json]
cinewright render-shot <shot_id> --deliverable <id> [--timing <timing.json>] [--image <ref>] [--project <dir>] [--json]
cinewright timing [--out <file>] [--project <dir>] [--json]
cinewright mix --deliverable <id> [--image <ref>] [--project <dir>] [--json]
cinewright compose [--sequence <id>] [--provider <id>] [--plugins <dir>]... [--project <dir>] [--json]
cinewright narrate [--line <id>]... [--retake <line>]... [--provider <id>] [--plugins <dir>]... [--project <dir>] [--json]
```

`--deliverable` takes a delivery profile name from `registry/profiles/` (`landscape_web`, `vertical_social`; see `registry/README.md`) or a path to a profile file: anything with a `/` or ending in `.json`. An unknown name exits 2 and lists the names. `--pack` chooses the style pack (default `neutral`): `init` sets `style.pack` and pins the pack's version and content hash in `packs`, so a later change to the pack never silently changes the project. When a pack changes on disk, compiling fails with `pack.pin_mismatch` until `cinewright pack pin <id>` records the new pin as a new revision. Packs are found in each folder of `CINEWRIGHT_PACK_PATH` (separated like `PATH`), then in the repository's `packs/`.

`compile` and `render-shot` reach the shot's backend through the engine's plugin registry (M5.4a); the CLI imports no plugin package. `compile` is a developer tool until `cinewright render` (M5.4): it compiles one shot for one deliverable into a HyperFrames composition (`plugins/backend-hyperframes`), and exits 3 listing every compile error with its entity, field and rule. `render-shot` compiles the shot into `.cinewright/compiled/` and renders it in the render image (`--image` or `CINEWRIGHT_IMAGE`) with the network off and run limits, into the disposable cache `.cinewright/cache/renders/<key>/`; a cached render runs no container. A failed render exits 8 naming the shot and the limit or error.

`narrate` is a developer tool until `cinewright render` (M4): for each line (or each `--line`), it keeps a valid user-selected take, reuses a take of the routed TTS provider whose request key still matches, or makes one, and selects it on the line as the `narration` job. `--retake` always makes a new take. Providers are routed by `--provider`, then `settings.providers.tts`, then free plugins the speaker has a binding for, then paid ones whose secrets are set (D29). Plugins are found on `--plugins` folders, `CINEWRIGHT_PLUGIN_PATH`, then the first-party `plugins/`. A provider failure exits 9 naming the line and provider; takes already made are kept, so a re-run makes only the rest. A refused line (a cloned voice with no consent record) exits 3 with its finding.

`compose` (M4.3a) chooses a music bed for each sequence from a music provider (`--provider`, then `settings.providers.music`, then free plugins first) and selects it in `sequence.music`, keeping a bed the user chose and reusing one whose request still matches. The request comes from the pack's `sound.music` tokens, the sequence's mood and `music_bed`, and its solved length; beds are instrumental. Where `sound.sfx.enabled` is true, each name in a scene's `sound.sfx` becomes a sound effect. The first-party `library_audio` plugin reads `library.json` files on `CINEWRIGHT_AUDIO_LIBRARY_PATH`. No matching bed is a `compose.no_match` finding (exit 3); a provider failure exits 9.

`mix` (M4.4) mixes the solved timeline for one deliverable in the render image (`--image` or `CINEWRIGHT_IMAGE`) with the network off: takes at their lines, the sequence's music bed ducked under speech by the pack's `sound.duck` tokens, sound effects at their scenes, then gain to the profile's integrated loudness and, when needed, a 4× oversampled limiter at its true-peak target. The result is cached by mix key in `.cinewright/cache/mixes/`; it prints the PCM hash (D33). Unmet targets (`mix.loudness_unmet`) exit 3 and cache nothing; a failed mixer exits 8.

`timing` solves the timing (M4.2): scenes from the selected takes and the pack's pacing tokens (`sound.voice`), shots tiled across their scene, sequences end to end. It prints the timeline or, with `--json`, the table, spans and findings; `--out` writes the table. Error findings exit 3. `compile` and `render-shot` use the solved timing when `--timing` is not given.

Without `--project`, a command uses the nearest directory upward that holds `cinewright.json`. `--file -` reads the patch from stdin.

## Patches

A patch is JSON (`core/schema/patch.schema.json`):

```json
{
  "base_revision": 7,
  "author": { "kind": "session" },
  "mode": "propose",
  "reason": "Make scene 3 tenser",
  "ops": [{ "op": "set", "entity": "s03_the_problem", "path": "/mood", "value": ["tense", "building", "urgent"] }]
}
```

- **`base_revision`:** the revision you read. `cinewright status` prints the current one, and so does the last line of `patch apply`. (`show --json` prints the stored form, which has no revision.)
- **`author`:**
  - `user` for a person;
  - `session` for an agent acting directly for the user (conversational edits);
  - `agent` with a `role`, or `job` with a `name`, for pipeline work.
  - In v0.1 the caller asserts it, and every log entry records it with the session id (`CINEWRIGHT_SESSION_ID`, D41).
- **`mode`:** `patch apply` and `patch propose` set `mode` from the command.
- **Values** are bare: the store adds `{ value, state }` and sets the state from the author. `cinewright schema <kind>` lists every path of an entity kind with its type, allowed values and an object's keys.
- **Times:** a value whose type is frames (`cinewright schema` says `frames`) also takes `"18s"`, `"1500ms"` or `"HH:MM:SS:FF"`. The string replaces that number only, never an object: scene `duration` is `{ target, flex, sync }`, so the seconds go in `duration.target`:

```json
{
  "base_revision": 7,
  "author": { "kind": "session" },
  "mode": "propose",
  "reason": "Scene 3 runs about 18 seconds, synced to the voiceover",
  "ops": [
    {
      "op": "set",
      "entity": "s03_the_problem",
      "path": "/duration",
      "value": { "target": "18s", "flex": 0.15, "sync": "voiceover" }
    }
  ]
}
```

| Op | Fields | Does |
| --- | --- | --- |
| `set` | `entity`, `path`, `value` | Sets a field or map entry |
| `unset` | `entity`, `path` | Returns a field to `open`, or removes a map entry |
| `insert` | `entity`, `path` (an entity list), `value` (the new entity with its `id`), `after` (id, `null` = first, absent = last) | Adds an entity |
| `remove` | `entity` | Removes an entity from its list |
| `move` | `entity`, `after` | Reorders within the same list |
| `lock` / `unlock` | `entity`, optional `path` | Locks a field, a list, or the whole entity (users; gates may lock) |
| `suggest` | `entity`, `path`, `value` | Stores a suggestion; a patch is all suggestions or none |

**Who may change what** (D25; details in `core/schema/README.md`):
- Agents and jobs write only `open` and `agent` fields, and only change `open` or `agent` lists. A patch that touches a `user` or `locked` field, or removes a `user` item, is stored as a pending suggestion (exit 5) for the user to approve.
- Session patches are proposed first while the project setting `propose_conversational_edits` is on, which is the default.
- Only a user approves (`patch approve`), and a revert acts as the user (`patch revert`). Agent harnesses must never run either without asking the user (D41).

**Checked before it is stored.** A patch stored as pending (a proposal, a session edit proposed first, a suggestion, or a patch blocked by authorship) is first checked as the approving user would apply it: paths, values, times, conflicts and the whole-IR validation. An invalid one exits 3 and a stale one exits 4, and neither is stored, so the user is never asked to approve a patch that cannot apply. Authorship is not checked then: a block is what pending is for.

**A failed approve decides nothing.** When `patch approve` fails, because a later revision changed the same fields (exit 4) or because the project changed so the patch no longer applies (exit 3, for example a lock or a removed reference), the patch stays pending and the log records an `approve_failed` entry. `patch list --pending` shows the last failure under the patch. Then rebase it (read again, propose a new patch, reject the old one), or fix what blocks it and approve again, or reject it.

## Output

The human output is the readable diff, one line per op:
- `~ entity /path: old → new  [state]` for `set` and `unset`;
- `+ entity /list after x: id`, `- id`, `> id first`;
- `lock entity /path`, `unlock entity /path`;
- `? entity /path: value` for `suggest`.

A status line follows: `applied revision N (sha256:…)`, `pending pN (reason)`, `rejected:` with one line per error, or `conflict:` with the fields and revisions. After a failed approve, a last line says the patch stays pending.

`--json` prints `{ status, revision?, state_hash?, pending_id?, reason?, blocked?, errors?, conflicts? }`.

**Errors** are `{ op, entity, pointer, rule, message }`:
- `op` is the index of the op the error is about. Errors from the whole-IR check name the op that wrote there; `op` is null only when no op did, or for the patch as a whole.
- `message` says what was expected: the expected type (`schema.type`), the allowed values (`schema.enum`), the missing field (`schema.required`), or the allowed fields (`schema.additionalProperties`). A malformed op names the field it needs, or the op kinds.
- One round reports every independent problem: an op that fails is skipped and the others still run, an unknown property is skipped and the rest of the entity is still checked, and the whole-IR check runs on what did apply.

`patch list --pending --json` prints `{ revision, pending }`: the current revision, and each pending entry with `approve_failed` when its last approval failed.

`status` prints the current revision, its state hash and the pending ids; `--json` prints `{ revision, state_hash, pending }`.

`schema` lists the entity kinds; `schema <kind>` prints every authorable path of that kind as patch ops address it, generated from `core/schema`: `field`, `list` (its item kind) or `map entry` (`<name>` is the entry), the value's type and allowed values, and an object's keys indented below, `(optional)` when they may be left out.

`schema tokens` prints every style token path with its type, bounds and allowed values (the core vocabulary, `core/schema/pack/README.md`); `--json` prints them as `[{ path, type, enum?, minimum?, maximum? }]`. A style override (`/style/overrides/<path>`) and a `{ "token": <path> }` reference must use one of these paths or one under `ext.`, with a value of that type, or the patch is rejected (`semantic.unknown_token`, `semantic.token_type`, `semantic.token_bounds`).

`components` lists the component catalog (D31) with each summary. `components <id>` prints the component's props, with each type, whether it is required and its description, plus the template regions it fits; `--json` prints its catalog entry and props schema. Every patch is checked against this catalog:
- **Unknown component:** a layer's component must be in the catalog (`semantic.unknown_component`).
- **Props:** each prop set must be one the component declares (`props.unknown`), with a valid value (`props.<keyword>`).
- **Required props:** a missing required prop is caught when the shot compiles, not when a patch applies.

`show` prints the readable view (convention 14):
- the entity's kind and id;
- every field with its state as a trailing comment;
- times in seconds (`--frames` for frames);
- script lines inline in scenes, with their speaker, direction, `on_screen` and `lipsync`;
- pending suggestions under their field;
- child entities `--depth` levels deep (default 1).

`show --json` prints the stored form. The view is output only; never parse it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, including a patch stored as pending because it was proposed (after it passed the checks) |
| 1 | Internal error |
| 2 | Usage |
| 3 | Invalid patch or IR (schema, semantic, path, or an op the author may not send) |
| 4 | Conflict: a revision after `base_revision` changed the same fields; read again and rebase |
| 5 | Blocked by authorship and stored as a pending suggestion |
| 6 | The project failed to load: edited outside the store, a corrupt or missing file |
| 7 | The store lock stayed held by another process (`CINEWRIGHT_LOCK_TIMEOUT_MS`, default 10 s) |
| 8 | A render failed: it hit its timeout or memory limit, or `render-job` failed (`render-shot`, `mix`) |
| 9 | A provider plugin failed, or none was usable (`narrate`, `compose`) |

## Test switches

`CINEWRIGHT_SESSION_ID` and `CINEWRIGHT_FIXED_TIME` pin the session id and log time, for reproducible builds such as `test/fixtures/m1-reference/build.sh`.
