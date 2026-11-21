# cinewright CLI

`cinewright` is how people and agents (Claude Code, Codex and others) create and edit a project. Every IR write goes through the IR store: never edit `cinewright.json` or `sequences/*.json` by hand (D25, D40). A file changed outside the store makes the project fail to load (exit 6).

## Commands

```
cinewright init <dir> --id <project_id> --deliverable <id>=<profile name or path> [--deliverable …] [--pack <id>] [--title <text>] [--workflow <id>] [--budget <usd>] [--json]
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
cinewright plan [--deliverable <id>]... [--run <id>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]
cinewright render [--deliverable <id>]... [--until <stage>] [--no-critics] [--jobs-only] [--retake <line>]... [--provider <id>] [--out <dir>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]
cinewright mix --deliverable <id> [--image <ref>] [--project <dir>] [--json]
cinewright compose [--sequence <id>] [--provider <id>] [--plugins <dir>]... [--project <dir>] [--json]
cinewright narrate [--line <id>]... [--retake <line>]... [--provider <id>] [--plugins <dir>]... [--project <dir>] [--json]
cinewright review [<gate>] [--run <id>] [--project <dir>] [--json]
cinewright review approve <gate> [--project <dir>] [--json]
cinewright review reject <gate> --note <text> [--project <dir>] [--json]
cinewright review variants <gate> <entity> [-n <count>] [--project <dir>]
cinewright review choose <variant> --run <id> [--project <dir>] [--json]
cinewright tasks [--project <dir>] [--json]
cinewright tasks show <id> [--project <dir>]
cinewright tasks submit <id> --file <output.json> [--project <dir>]
```

`init` writes a budget cap (D17): `--budget <usd>`, else the engine's default, `default_budget_usd` in `engine/settings.json` ($5). `--workflow <id>` sets `settings.workflow` to a template in `engine/templates/` (`explainer`, `ad`). `--deliverable` takes a delivery profile name from `registry/profiles/` (`landscape_web`, `vertical_social`; see `registry/README.md`) or a path to a profile file: anything with a `/` or ending in `.json`. An unknown name exits 2 and lists the names. `--pack` chooses the style pack (default `neutral`): `init` sets `style.pack` and pins the pack's version and content hash in `packs`, so a later change to the pack never silently changes the project. When a pack changes on disk, compiling fails with `pack.pin_mismatch` until `cinewright pack pin <id>` records the new pin as a new revision. Packs are found in each folder of `CINEWRIGHT_PACK_PATH` (separated like `PATH`), then in the repository's `packs/`.

`compile` and `render-shot` reach the shot's backend through the engine's plugin registry (M5.4a); the CLI imports no plugin package. `compile` is a developer tool until `cinewright render` (M5.4): it compiles one shot for one deliverable into a HyperFrames composition (`plugins/backend-hyperframes`), and exits 3 listing every compile error with its entity, field and rule. `render-shot` compiles the shot into `.cinewright/compiled/` and renders it in the render image (`--image` or `CINEWRIGHT_IMAGE`) with the network off and run limits, into the disposable cache `.cinewright/cache/renders/<key>/`; a cached render runs no container. A failed render exits 8 naming the shot and the limit or error.

`narrate` is a developer tool until `cinewright render` (M4): for each line (or each `--line`), it keeps a valid user-selected take, reuses a take of the routed TTS provider whose request key still matches, or makes one, and selects it on the line as the `narration` job. `--retake` always makes a new take. Providers are routed by `--provider`, then `settings.providers.tts`, then free plugins the speaker has a binding for, then paid ones whose secrets are set (D29). Plugins are found on `--plugins` folders, `CINEWRIGHT_PLUGIN_PATH`, then the first-party `plugins/`. A provider failure exits 9 naming the line and provider; takes already made are kept, so a re-run makes only the rest. A refused line (a cloned voice with no consent record) exits 3 with its finding.

`compose` (M4.3a) chooses a music bed for each sequence from a music provider (`--provider`, then `settings.providers.music`, then free plugins first) and selects it in `sequence.music`, keeping a bed the user chose and reusing one whose request still matches. The request comes from the pack's `sound.music` tokens, the sequence's mood and `music_bed`, and its solved length; beds are instrumental. Where `sound.sfx.enabled` is true, each name in a scene's `sound.sfx` becomes a sound effect. The first-party `library_audio` plugin reads `library.json` files on `CINEWRIGHT_AUDIO_LIBRARY_PATH`. No matching bed is a `compose.no_match` finding (exit 3); a provider failure exits 9.

`render` (M5.4b) runs every non-agent job in order: narrate each line, solve the timing, compose music, render each shot and transition segment per deliverable, mix, write caption sidecars, and assemble. Each step reports its key and whether its cache hit, so an edit re-does only what it changed. `--until narrate|timing|compose|shots|mix|captions|assemble|critique` stops after a stage; `--out <dir>` copies each deliverable's MP4, `.srt`, `.vtt` and a provenance `manifest.json` there. Error findings (a line with no valid take, a shot that starts outside its scene, a compile error) stop the run after the step that reports them and exit 3; a render failure exits 8; a provider failure exits 9. Last comes the critique step (M6.1a; `--no-critics` skips it): `render.check` per shot (HyperFrames `check` and text boxes at the shot's keyframes, cached in its render entry), a frozen transcript of each selected take that has none, when an STT plugin offers `stt.transcribe` (M6.1c; reused afterwards), every `critic` plugin (first-party: `critic_layout`, `critic_media`, `critic_script`), the licence and consent check, and the solver's findings, merged and deduped by signature into `.cinewright/cache/reports/<assembly key>.json` (`{ deliverable, revision, critics: [{ id, version, baseline? }], findings, measured }`). Each finding prints with its rule, entity path, deliverable, frame and id (`f_…`, stable while the defect persists). Any error finding exits 10; the deliverables are still written. A report for the same assembly, revision and critic versions is reused. The `--json` report: `{ status, revision, state_hash, steps: [{ id, kind, key, hit, ms }], deliverables: { <id>: { file, sha256, framemd5, pcm_sha256, frames, captions, manifest?, critique?: { file, findings } } }, findings, until }`, with `status` `findings` when a critic reported an error.

`mix` (M4.4) mixes the solved timeline for one deliverable in the render image (`--image` or `CINEWRIGHT_IMAGE`) with the network off: takes at their lines, the sequence's music bed ducked under speech by the pack's `sound.duck` tokens, sound effects at their scenes, then gain to the profile's integrated loudness and, when needed, a 4× oversampled limiter at its true-peak target. The result is cached by mix key in `.cinewright/cache/mixes/`; it prints the PCM hash (D33). Unmet targets (`mix.loudness_unmet`) exit 3 and cache nothing; a failed mixer exits 8.

`timing` solves the timing (M4.2): scenes from the selected takes and the pack's pacing tokens (`sound.voice`), shots tiled across their scene, sequences end to end. It prints the timeline or, with `--json`, the table, spans and findings; `--out` writes the table. Error findings exit 3. `compile` and `render-shot` use the solved timing when `--timing` is not given.

`plan` (M7.1) starts or resumes a workflow run and stops before paid production, at the storyboard gate (G2). Intake (P0) runs first and exits 3 with its findings: no budget cap, no deliverable, a shot type or transition v0.1 cannot make, or a role or job with no installed plugin (an agent role needs an `llm` plugin; set it to `human` in `settings.roles` otherwise). Then it runs what the reconciler derives from the IR for the project's workflow template (`settings.workflow`, default `explainer`; `engine/templates/`) and autonomy preset (`autonomy`, default `guided`; `engine/presets.json`): an agent task while a field its role fills is open, or when what it read changed since it filled them (outputs that are `user` or `locked` are never redone; that change becomes a warning); a human role's task, which pauses the run for the queue; the gates the preset pauses at (a gate passes when every field it names is locked); and the pipeline steps up to the shots. It exits 11 when the run pauses, printing the pause and the run id (`--json`: `{ status, run, pause: { kind, id } }`). Without `--run` it resumes the latest run that did not finish, else starts one. Until the agent runner lands (M7.4), an agent task fails with `agent.unavailable`. `render` runs as a workflow run too, whose one task is the pipeline (`--jobs-only`); it follows the preset once agents can run (M7.4). A run's state is `.cinewright/runs/<run>/`: `ledger.jsonl` (each task started, done or failed, by its key), `events.jsonl` (ids, hashes and timings, with secrets redacted) and `outcome.json`. It is disposable: deleting it re-runs work, never re-decides it, and production state stays in the IR and `log/`.

`review` (M7.6) prints the gate packet for each gate of the project's template, or one `<gate>` (`script`, `storyboard`, `final`): the field changes since the gate was last approved, how many fields approving would lock, open suggestions, findings, and the money spent (`log/spend.jsonl`) against the cap. `--json` prints the packet (`engine/schema/gate-packet.schema.json`). `review approve <gate>` locks every field the gate names, as the job `gate.<gate>`; an agent can never approve a gate (D41), and only the final gate can be approved automatically (`--approve-final`, recorded with the reason `auto`). `review reject <gate> --note` appends the note to the project's `instructions`; the gate's owning role (G1 the writer, G2 and G3 the director) reads it in its next context pack as `user_instruction:<seq>`. `review choose <variant> --run <id>` applies a stored variant (`.cinewright/runs/<run>/variants/`) as the user's own patch. `review variants` needs the owning role's agent and exits 9 until roles are defined (M7.5). `tasks` lists what waits for a person, derived from the IR: human-role tasks and gates not yet approved; `tasks show <id>` prints one. `tasks submit` hands in a human role's output, checked against the role's output schema like an agent's (`human.invalid_output`), and exits 9 until roles are defined (M7.5). A gate the template does not have exits 3.

Assets live in the project's content-addressed store, `.cinewright/cas/`. When an asset is missing there, every command fetches it from the read-only remotes in `CINEWRIGHT_CAS_REMOTE` (comma-separated URL templates with a `{hex}` placeholder, `https:` or `file:`; e.g. `https://example.org/cas/{hex}`), tried in order. No credential is sent. A fetched object is stored only if it hashes to the requested hash and is no larger than the asset's recorded size; otherwise the command fails with `cas.remote_corrupt` or `cas.remote_oversized`. A missing asset names the remotes it tried. `uv run cinewright-eval cas-export <project> --to <dir>` writes a project's referenced assets as flat files named by hex, ready to upload to such a remote.

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
| 10 | `render` finished and a critic reported an error finding (M6.1a) |
| 11 | A workflow run paused: at a gate, for a human task, or at the budget cap (`plan`, M7.1a) |

## Test switches

`CINEWRIGHT_SESSION_ID` and `CINEWRIGHT_FIXED_TIME` pin the session id and log time, for reproducible builds such as `test/fixtures/m1-reference/build.sh`.
