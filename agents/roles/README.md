# Agent roles

Each role is a folder `roles/<id>/` (M7.4):

- `role.json` (`schema/role.schema.json`): its tier, what it reads (selectors), what it may write (entity kinds and field paths; the store enforces them per task, with the task's entities), its unit (`per`), its input budget, output cap and repair rounds.
- `prompt.md`: craft principles and the role's contract only (AGENTS.md §2.2). A lint test fails on a colour, font family, easing, duration, pack id, component id or model name in any prompt; pack rules and the component catalog reach the model as data in the context pack. A prompt may cite craft rules (`craft_rule:<id>`, from `craft-rules.json`) by id.
- `output.schema.json`: the role's typed output. The engine turns it into a patch with a deterministic function (`toPatch`); the model never writes ops, HTML or files (D31).

The v0.1 roles arrive with M7.5a–c (Producer and Writer, Director, Shot Builder and Editor).
