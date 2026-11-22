# Agent roles

Each role is a folder `roles/<id>/` (M7.4):

- `role.json` (`schema/role.schema.json`): its tier, what it reads (selectors), what it may write (entity kinds and field paths; the store enforces them per task, with the task's entities), its unit (`per`), its input budget, output cap and repair rounds.
- `prompt.md`: craft principles and the role's contract only (AGENTS.md §2.2). A lint test fails on a colour, font family, easing, duration, pack id, component id or model name in any prompt; pack rules and the component catalog reach the model as data in the context pack. A prompt may cite craft rules (`craft_rule:<id>`, from `craft-rules.json`) by id.
- `output.schema.json`: the role's typed output. The engine turns it into a patch with a deterministic function (`toPatch`); the model never writes ops, HTML or files (D31).

The v0.1 roles (M7.5a–c):

| Role | Writes | Checks (engine/src/agents/roles/) |
| --- | --- | --- |
| `producer` | `project.plan` (summary, `target_seconds`, beats); `style.pack` only while it is open, otherwise its pack choice is stored as a suggestion | the pack is installed |
| `writer` | the script: beats and lines, every line spoken by the narrator | ids valid, unique and unused; spoken length (words at `script.pace_wpm` plus the pack's voice pads) within `script.flex` of the plan's target and every deliverable's `max_duration`; on-screen text within the pack's word density |
| `director` | the scene plan: sequences, scenes (intent, mood, lines, transition, sound; timing is the Editor's), shots (type, framing, start anchor, layout per aspect class) and a layer stub (id and component) per chosen component | ids valid, unique and unused, shot ids under their scene; every line in exactly one scene; shot types and transitions v0.1 can make; a pack template for every deliverable's aspect class; components in the catalog; the first shot starts at its scene's first line, later shots in order, all on the scene's own lines |

The Shot Builder (which fills the layer stubs: the explainer and ad templates derive it while a layer's props are empty or open) and the Editor follow in M7.5c.
