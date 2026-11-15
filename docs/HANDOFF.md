# Handoff — design to implementation

Start here. This folder takes Cinewright from design (done in claude.ai) to implementation (Claude Code).

## What Cinewright is

An open-source, agent-driven **production framework** for professional video. It models a production the way a studio does: project → sequences → scenes → shots → layers, plus a cast, style packs and an asset registry, all in one typed IR. Agents fill studio roles (writer, director, shot builders, editor, critics), and any role can be a human. Renderers compile the IR into media: HyperFrames for 2D and compositing, Blender for 3D, plus generative providers. Every output passes a quality loop.

It must be **neutrally professional for every request**. The maintainer's own test cases and preferred looks are fixtures, never defaults (see `AGENTS.md`).

## Read in this order

1. `AGENTS.md` — the rules: neutrality, architecture invariants, testing, licensing boundaries.
2. `docs/DESIGN_SPEC.md` — the full architecture. Its **Decision log** (D1–D41) is binding.
3. `docs/V0_1_PLAN.md` (approved 2026-11-13) — what to build first, as milestones with acceptance criteria, plus the multi-agent orchestration workflow (§Multi-agent orchestration), the open issues from the readiness review (§Open issues) and the external facts checked on 2026-11-13 (§External facts).

## Decisions already made (summary)

The full table is in the spec's decision log.

- Apache-2.0 core. The Blender backend is a separate GPL-3.0 package, called out of process.
- TypeScript for engine, IR tooling, CLI and Studio; Python for the Blender backend, eval and audio analysis.
- JSON Schema is the IR source of truth, with generated types. The IR is stored as canonical JSON written only by the IR store; nobody hand-writes YAML (D40).
- LangGraph runtime behind an interface. Local-first deployment.
- Claude is the reference LLM provider; others plug in through the same interface.
- HyperFrames is the core 2D backend and compositor. Blender (headless, Cycles, 5.2 LTS) is the core 3D backend from v0.3. Remotion is an optional plugin only.
- No generative model is a default in code; routing plus a monthly benchmark decides.
- Guided autonomy by default. A budget is required. Telemetry is off by default. No proxy workflow.
- From the implementation-readiness review (D25–D41, approved 2026-11-13): `{ value, state }` field wrappers and id-addressed patches on a single-writer IR store; conversational edits proposed first and applied on approval, with the session id logged and approvals never auto-approved by an agent harness; one branch writes a project's IR in v0.1; a Script entity; frame-based time; one timeline with per-aspect layouts; provider-neutral voice profiles; agents emit typed IR, never renderer code; transitions as separate segments and captions compiled into shots; benchmark tier A (frozen IR, every PR) and tier B (live agents, nightly); workflow templates plus an IR reconciler, with LangGraph holding run state only; two packs in v0.1.

## Still open

Needed during M0 (see `V0_1_PLAN.md` M0.0):

- The GitHub repository `jeremycai99/cinewright` exists (private, created 2026-11-13). Rulesets need the repository public or a paid plan. The maintainer chose to keep it private for now, so M0.3's required checks are not enforced by GitHub; apply `.github/rulesets/main.json` when that changes.

Not blocking M0–M1:

- Confirm the name Cinewright, then pick the GitHub org and npm scope. The npm and PyPI names were free as of 2026-11-12. Packages use a provisional scope until then.
- Who authors the first benchmark briefs; budget for paid raters.
- CI provider for GPU render tests (v0.3).
- Open issues 6–8 in `V0_1_PLAN.md` §Open issues (the GSAP licence before M2.4). Issue 5, byte-identical output, was resolved by the M0.2 spike.

## How to work in this repo (for Claude Code)

- Plan before coding each milestone; keep each PR to one task from `V0_1_PLAN.md` with its acceptance criteria as the PR checklist.
- Schema and contracts first, with tests, before features that depend on them.
- Verify third-party APIs (HyperFrames, ElevenLabs, LangGraph, Blender bpy) against their current docs before coding against them; they change often. Pin versions.
- Run the neutrality test from `AGENTS.md` §2.3 on every PR.
- Update `docs/DESIGN_SPEC.md` in the same PR when a design decision changes; add a decision-log row.

## Suggested first prompt in Claude Code

> Read AGENTS.md, docs/HANDOFF.md, docs/DESIGN_SPEC.md (especially the Decision log) and docs/V0_1_PLAN.md (approved 2026-11-13, including its M1 conventions). M0 is done (2026-11-14). Continue the current milestone's task plan in `docs/plans/` from the first task whose PR has not merged; if the next milestone has no approved plan yet, plan it in detail and wait for my approval before writing code.
