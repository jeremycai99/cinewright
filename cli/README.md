# cinewright CLI

`cinewright` is how people and agents (Claude Code, Codex and others) create and edit a project. Every IR write goes through the IR store: never edit `cinewright.json` or `sequences/*.json` by hand (D25, D40). A file changed outside the store makes the project fail to load (exit 6).

## Commands

```
cinewright init <dir> --id <project_id> --deliverable <id>=<profile.json> [--deliverable …] [--title <text>] [--json]
cinewright patch apply   --file <patch.json> [--project <dir>] [--frames] [--json]
cinewright patch propose --file <patch.json> [--project <dir>] [--frames] [--json]
cinewright patch approve <pending_id> [--project <dir>] [--json]
cinewright patch reject  <pending_id> [--reason <text>] [--project <dir>] [--json]
cinewright patch list --pending [--project <dir>] [--json]
cinewright patch revert <revision> [--project <dir>] [--json]
cinewright show [<id>] [--depth <n>] [--frames] [--resolved --pack <tokens.json> [--deliverable <id>]] [--json] [--project <dir>]
```

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

- **`base_revision`:** the revision you read. `show --json` and the last line of `patch apply` tell you the current one.
- **`author`:**
  - `user` for a person;
  - `session` for an agent acting directly for the user (conversational edits);
  - `agent` with a `role`, or `job` with a `name`, for pipeline work.
  - In v0.1 the caller asserts it, and every log entry records it with the session id (`CINEWRIGHT_SESSION_ID`, D41).
- **`mode`:** `patch apply` and `patch propose` set `mode` from the command.
- **Values** are bare: the store adds `{ value, state }` and sets the state from the author.
- **Times:** a field in frames also takes `"18s"`, `"1500ms"` or `"HH:MM:SS:FF"`.

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
- Only a user approves (`patch approve`). Agent harnesses must never run `patch approve` without asking the user (D41).

## Output

The human output is the readable diff, one line per op:
- `~ entity /path: old → new  [state]` for `set` and `unset`;
- `+ entity /list after x: id`, `- id`, `> id first`;
- `lock entity /path`, `unlock entity /path`;
- `? entity /path: value` for `suggest`.

A status line follows: `applied revision N (sha256:…)`, `pending pN (reason)`, `rejected:` with one line per error, or `conflict:` with the fields and revisions.

`--json` prints `{ status, revision?, state_hash?, pending_id?, reason?, blocked?, errors?, conflicts? }`.

`show` prints the readable view (convention 14):
- the entity's kind and id;
- every field with its state as a trailing comment;
- times in seconds (`--frames` for frames);
- script lines inline in scenes;
- pending suggestions under their field;
- child entities `--depth` levels deep (default 1).

`show --json` prints the stored form. The view is output only; never parse it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, including a patch stored as pending because it was proposed |
| 1 | Internal error |
| 2 | Usage |
| 3 | Invalid patch or IR (schema, semantic, path, or an op the author may not send) |
| 4 | Conflict: a revision after `base_revision` changed the same fields; read again and rebase |
| 5 | Blocked by authorship and stored as a pending suggestion |
| 6 | The project failed to load: edited outside the store, a corrupt or missing file |
| 7 | The store lock stayed held by another process (`CINEWRIGHT_LOCK_TIMEOUT_MS`, default 10 s) |

## Test switches

`CINEWRIGHT_SESSION_ID` and `CINEWRIGHT_FIXED_TIME` pin the session id and log time, for reproducible builds such as `test/fixtures/m1-reference/build.sh`.
