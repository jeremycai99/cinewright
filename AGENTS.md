# AGENTS.md — Cinewright

Guidance for every coding agent (Claude Code, Codex, Cursor, etc.) and human contributor working in this repository. Read this before changing anything. `CLAUDE.md` imports this file.

## 1. What this project is

An open-source, agent-driven **production framework** for professional video: multi-sequence, multi-scene, multi-shot productions with a cast of narrators and characters, a style system, and a quality loop. It is built for a broad community — solo creators, marketing teams, educators, storytellers, studios, platform developers, and plugin authors — not for any single user, genre, or look.

Key documents: `docs/HANDOFF.md` (start here), `docs/DESIGN_SPEC.md` (architecture; its Decision log is binding), `docs/V0_1_PLAN.md` (current milestone plan). When this file and the spec disagree, raise it; do not silently pick one.

## 2. The prime directive: universal and neutral by design

**The framework must be neutrally professional for all requests.** Every default, heuristic, prompt, component, and critic rubric must be justifiable as good practice for the general case, not as one person's taste.

During development we use specific test cases, and some rendered clips are tuned to the maintainer's personal requirements. That is expected and useful — but those preferences are **fixtures, not defaults**. They must never leak into the core.

### 2.1 Where taste is allowed to live

| Allowed location | What goes there |
| --- | --- |
| `packs/<name>/` | A named style pack: tokens, motion grammar, sound palette, prompt fragments. Opt-in only. |
| `fixtures/personal/` | The maintainer's own briefs, reference clips, and preferred packs used for dogfooding. Clearly labeled; never imported by core code. |
| `fixtures/benchmark/` | The neutral benchmark suite (see §4). |
| User / project config | Anything a user sets for their own project. |

### 2.2 Where taste is NOT allowed

- Core library code (`core/`, `engine/`, `agents/`) and shared components (`components/`): no hard-coded colors, fonts, easing curves, durations, voice IDs, music genres, aspect ratios, pacing, or "house style" phrasing.
- Agent system prompts: describe *craft principles* (hierarchy, contrast, rhythm, continuity, legibility, intelligibility), never a specific aesthetic ("make it dark and neon", "always use bold sans-serif").
- Critic rubrics: grade against the **brief + resolved style pack + general craft rules**, never against the maintainer's preferences.
- The default pack: must be a deliberately neutral, broadly professional pack (clean, legible, restrained), documented as such, and replaceable.

### 2.3 The neutrality test (apply to every PR)

Before merging, answer yes to all of these:

1. Would this default be reasonable for a corporate explainer, a children's lesson, a documentary, a product ad, *and* a narrative short?
2. If a user asked for the opposite style, can they get it by choosing a pack or overriding a field — without code changes?
3. Is every new aesthetic choice expressed as a token or pack rule rather than a literal in code?
4. Was the change validated on the neutral benchmark suite, not only on personal fixtures? (Applies from the v0.1-alpha gate on, once the first tier A fixtures exist; before that, say so in the PR.)
5. Does nothing in core import from `fixtures/personal/`?

If any answer is no, move the choice into a pack or config, or justify it in the PR as a general craft rule.

## 3. Architecture invariants (do not break)

1. **The IR is the single source of truth.** Project → Sequence → Scene → Shot → Layer, plus Script, Cast, Style, Assets. Agents and humans edit the IR; renderers only compile it. Never let a renderer, agent or workflow runtime hold production state the IR does not; runtime checkpoints are disposable caches (D37).
2. **Authorship states are sacred.** Every authorable field is `open`, `agent`, `user`, or `locked` (D25). Agents write only `open`/`agent` fields; they may *suggest* changes to `user` fields; they never touch `locked`. All IR writes go through the IR store (`cinewright patch`); never edit project JSON by hand or with a file-editing tool, including from a coding-agent session (D25, D40).
3. **Style is data.** All look-and-feel resolves through the override cascade (Project → Sequence → Scene → Shot → Layer) from style packs. Record the origin of every resolved value.
4. **Cast is first-class.** Narrators and characters are defined once (voice profile, performance baseline, visual sheet) and referenced by ID. Never inline a voice ID or character description in a scene.
5. **Everything external is a plugin.** LLMs, TTS, music, SFX, image/video generation, lip sync, STT, stock, renderers, critics, exporters. Core code calls interfaces, never vendor SDKs directly.
6. **Provider neutrality.** No feature may require a single vendor unless there is no alternative anywhere; if so, document it and keep the interface generic.
7. **Determinism.** Same resolved IR + same asset hashes + same plugin versions + same container digest ⇒ same output, meaning identical decoded-frame and PCM hashes (D33). LLM, TTS and generative outputs are not deterministic, so they are frozen into content-addressed storage as assets and reused until a re-take is requested. Render workers run in pinned Linux containers with the network disabled.
   - Blender backend specifics: pinned Blender LTS; one `blender -b` process per job (bpy is not thread-safe); Cycles is the default final engine; EEVEE only on EGL-enabled images that pass the headless smoke test; all bpy calls go through the version adapter.
8. **Every agent output is a typed IR patch plus a decision-log entry** citing the brief, user instruction, or pack rule that justifies it.
9. **Human-replaceable roles.** Any agent role can be set to `human` in config; nothing may assume an agent fills it.
10. **License boundary for Blender.** `plugins/backend-blender` is GPL-3.0 because it calls Blender's Python API. Core and every other Apache-2.0 package must never `import bpy` or vendor Blender code; they talk to the Blender backend only through the process-boundary job interface. Production renders use scripted headless Blender; the Blender MCP connector is for interactive authoring and debugging only.
11. **No model is a default in code.** Generative providers are selected by capability routing and the monthly model benchmark. Never hard-code a model name outside its plugin.
12. **Agents emit typed IR, never renderer code.** Shot Builders output components, props, token references and anchor-relative timing; compilers own HTML and bpy generation (D31). Raw compositions are user-authored, content-addressed assets.

## 4. Testing and evaluation

### 4.1 Two fixture sets, two purposes

- **`fixtures/benchmark/` — the neutral suite (gates merges).** A diverse, versioned set of briefs spanning genres, lengths, aspect ratios, cast sizes, languages, and styles. Minimum coverage:
  - Genres: explainer, product launch, ad (6s/15s/30s), documentary segment, narrative short with dialogue, course lesson, social cut-down, data story, localization of an existing project.
  - Lengths: ≤15 s, 30–60 s, 3–5 min, ≥10 min.
  - Aspect ratios: 16:9, 9:16, 1:1, 4:5.
  - Cast: no voice; single narrator; narrator + 2 characters; 4+ characters with on-screen lip sync.
  - Styles: at least 6 packs with deliberately contrasting aesthetics (minimal corporate, playful kids, cinematic doc, retro, editorial, brand-locked).
  - Languages: at least 3, including one non-Latin script and one right-to-left script.
  - Autonomy presets: Auto, Guided, Directed, Manual.
- **`fixtures/personal/` — dogfooding (never gates merges alone).** The maintainer's own briefs and preferred looks. Useful for catching regressions in real use; a change that only improves these must still not regress the benchmark.

### 4.2 What "passing" means

- Two benchmark tiers (D36). **Tier A** (frozen IR and frozen assets, deterministic, no paid APIs) gates every PR, including PRs from forks. **Tier B** (briefs through live agents and providers, several runs per brief) runs nightly and before releases and is judged per category with run-to-run variance. Critic model, prompt and rubric versions are pinned per baseline.
- All deterministic checks pass on every benchmark render: layout overflow/collision, contrast floors, safe areas, loudness target and true-peak, no silence gaps or clipping, STT matches script, ffprobe spec, caption timing.
- Rubric scores (from critics) do not regress beyond tolerance on any benchmark category — not just on average. A change that helps one genre and hurts another needs explicit sign-off.
- Pairwise human preference studies use raters who are not the maintainer, on blinded benchmark outputs.
- New features ship with at least one new benchmark brief that exercises them in a non-personal context.

### 4.3 Unit and contract tests

- IR schema validation, cascade resolution, authorship enforcement, and patch merging are unit-tested.
- Every plugin passes the conformance kit (golden IR fixtures → expected outputs or properties) before registry listing.
- Provider plugins are tested against recorded responses; live-API tests are opt-in and budget-capped.

## 5. Quality bar

"Not shabby" is measurable. Output must meet professional norms by default:

- Typography: consistent type scale, no orphans/widows in titles, minimum on-screen text size per resolution, readable hold times.
- Motion: eased (no linear default), consistent duration scale, continuity across cuts, no element jitter.
- Composition: grid-aligned, safe-area compliant for every target aspect ratio.
- Audio: dialogue intelligible over music (ducking), loudness normalized to the delivery target, no clicks at edits.
- Pacing: cuts and on-screen changes aligned to dialogue and music beats.
- Accessibility: captions available, contrast floors met, no flashing beyond accepted thresholds.

These are craft rules, not a style. Packs may change *how* they are met, not *whether*.

## 6. Working conventions for agents

- Read the relevant spec section before changing a subsystem. Keep the IR schema, plugin contracts, and this file in sync with code; update docs in the same PR.
- Prefer adding a token, pack rule, component, or plugin over adding a special case in core.
- Never commit API keys, personal media, or cloned-voice assets. Voice clones require a consent artifact; the render gate must enforce it.
- Respect output licenses: every asset records provider, model, plan tier, and license; the render gate blocks assets without a commercial-use license when the project requires one.
- Keep generated media out of git; use content-addressed storage and reference by hash.
- When a request or test case reflects a specific person's taste, implement the *capability* generally and put the taste in a pack or fixture.
- When unsure whether something is a general craft rule or a preference, treat it as a preference and make it configurable.

## 7. Repository layout (target)

```
core/        IR schema, cascade resolver, authorship rules, patch engine
engine/      workflow runtime, gates, task graph, cost ledger
agents/      role definitions and prompts (craft principles only)
cli/         the `cinewright` command-line tool (runs on the host)
plugins/     first-party providers, backends, critics, exporters
  backend-blender/  GPL-3.0, separate package (see invariant 10)
packs/       style packs (neutral default + curated set)
components/  reusable motion components used by packs
fixtures/
  benchmark/ neutral evaluation suite (gates merges)
  personal/  maintainer dogfooding (never imported by core)
eval/        harness, rubrics, human-rating tools, reports
registry/    delivery profiles, loudness targets, disclosure policies
container/   pinned render image (Dockerfile, pins) and its render-job entry point
tools/       repository checks and the render-container runner (Python)
studio/      web UI
docs/        spec, guides, plugin authoring
```

## 8. Anti-patterns to reject in review

- "Looks great on my demo" without benchmark results.
- A literal hex color, font name, easing curve, or voice ID in core or agent prompts.
- A critic that rewards a particular aesthetic instead of conformance to the brief and pack.
- A vendor SDK imported outside its plugin.
- An agent overwriting a `user` or `locked` field.
- A feature that only works at one aspect ratio, one language, or one cast size.
