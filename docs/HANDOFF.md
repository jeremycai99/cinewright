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

- The GitHub repository `jeremycai99/cinewright` (created 2026-11-13) is public (decision 9, 2026-11-25). The images go public and `.github/rulesets/main.json` is applied after the history scan (`docs/plans/alpha-gate.md` Task 0); until then M0.3's required checks are not enforced by GitHub.

Not blocking M0–M1:

- Name: Cinewright, at `jeremycai99/cinewright`, npm scope `@cinewright` (decision 15, 2026-11-25). The maintainer creates the npm organisation; the GitHub organisation `cinewright` belongs to an unrelated project.
- Who authors the first benchmark briefs; budget for paid raters.
- CI provider for GPU render tests (v0.3).
- Open issues 7–8 in `V0_1_PLAN.md` §Open issues. Issue 5, byte-identical output, was resolved by the M0.2 spike; issue 6, the GSAP licence, by the M2 plan (core components use WAAPI).

## How to work in this repo (for Claude Code)

- Plan before coding each milestone; keep each PR to one task from `V0_1_PLAN.md` with its acceptance criteria as the PR checklist.
- Schema and contracts first, with tests, before features that depend on them.
- Verify third-party APIs (HyperFrames, ElevenLabs, LangGraph, Blender bpy) against their current docs before coding against them; they change often. Pin versions.
- Run the neutrality test from `AGENTS.md` §2.3 on every PR.
- Update `docs/DESIGN_SPEC.md` in the same PR when a design decision changes; add a decision-log row.

## Editing a project

Create a project with `cinewright init`, then change it only with `cinewright patch` and read it with `cinewright show`. `cli/README.md` documents the commands, ops and exit codes. Conversational edits from a coding agent use the `session` author: they are proposed first, and the user approves them with `cinewright patch approve`. `cli/test/fixtures/m1-reference/` is a complete example built only through the CLI.

## Suggested first prompt in Claude Code

> Read AGENTS.md, docs/HANDOFF.md, docs/DESIGN_SPEC.md (especially the Decision log) and docs/V0_1_PLAN.md (approved 2026-11-13, including its M1 conventions). M0 is done (2026-11-14), M1 (2026-11-15) and M2 (2026-11-16). The task order from here is `V0_1_PLAN.md` §Revised task breakdown and order. Continue the current milestone's task plan in `docs/plans/` from the first task whose PR has not merged; if the next milestone has no approved plan yet, plan it in detail and wait for my approval before writing code.
