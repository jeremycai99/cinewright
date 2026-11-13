# CLAUDE.md

@AGENTS.md

AGENTS.md applies in full. In short:

- **Neutral by design.** The framework must be neutrally professional for every request. Personal test cases and preferred looks live only in `fixtures/personal/` and opt-in style packs, never in core code, agent prompts or critic rubrics. Validate changes on `fixtures/benchmark/`.
- **Binding decisions.** Follow the Decision log in `docs/DESIGN_SPEC.md`. Changing a decision means updating that log in the same PR.
- **Current work.** Implement `docs/V0_1_PLAN.md` one task per PR, using the task's acceptance criteria as the PR checklist. Plan before coding each milestone and get approval.
- **Contracts first.** IR schema and plugin interfaces come first, with tests, before features that depend on them.
- **Verify external APIs.** Check HyperFrames, ElevenLabs, LangGraph and Blender bpy against current docs before using them, and pin versions.
- **License boundaries.** Never `import bpy` outside `plugins/backend-blender` (GPL-3.0). Never import a vendor SDK outside its plugin. Never hard-code a model name outside its plugin.
- **Never commit** API keys, generated media or cloned-voice assets.
