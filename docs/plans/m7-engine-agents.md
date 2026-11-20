# M7 — Engine and Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20. Starts after the v0.1-alpha gate (`docs/plans/alpha-gate.md`). It is followed by `docs/plans/m6-2-3-vision-fix-loop.md`. One maintainer decision is due before Task 3: decision 12 (LangGraph).

**Goal:** Take a brief to a finished film with agents filling the roles, under the same store, solver, compiler and critics the alpha gate proved:
- a workflow runtime behind an interface, driven by a reconciler that derives every task from the IR;
- a scheduler with idempotency, limits, retries and fallback;
- an LLM provider interface with one reference plugin and cassette replay;
- an agent runner that builds context from read scopes and accepts only validated, in-scope, cited output;
- the v0.1 roles: Producer, Writer, Director, Shot Builder, Editor;
- gates, the four autonomy presets and a queue for human-filled roles;
- a cost ledger with a hard cap.

**Architecture:**
- **The IR decides what runs (D37).** `reconcile` is a pure function of the IR, the workflow template and the pipeline plan. A task exists when a field its role must fill is `open`, or when the inputs recorded for the patch that last filled it have changed. A human edit, an agent patch and a restart all go through it.
- **Run state is disposable.** `.cinewright/runs/<run>/` holds the ledger, the event log and gate packets. Deleting it loses no decision, no spend and no approval: those are in the IR, `log/patches.jsonl`, `log/decisions.jsonl` and the new `log/spend.jsonl`.
- **Agents return typed role output, and the runner turns it into a patch.** Each role has an output JSON Schema (script, scene plan, layers…). The provider constrains the model to it; the runner validates it in full, converts it to patch ops with a deterministic function, and submits the patch as that role. No agent writes ops, HTML or files (D31, invariants 8 and 12).
- **Everything a model touches is a plugin.** `plugins/llm-anthropic` is the only place a vendor SDK or a model name may appear (invariants 5 and 11). Tiers (`frontier`, `mid`) are the only thing core and engine name.
- **Packages:** `engine/` gains `runtime/`, `reconcile/`, `scheduler/`, `agents/`, `gates/`, `cost/`; `agents/` is a new data package of role definitions (prompt, scopes, output schema); workflow templates are data in `engine/templates/`.

**Tech Stack:** TypeScript, Ajv. `@anthropic-ai/sdk` inside `plugins/llm-anthropic` only, pinned exactly. `@langchain/langgraph` and `@langchain/langgraph-checkpoint-sqlite` only if decision 12 keeps them (1.7.5 and 1.1.1 on 2026-11-20). Facts are in §External facts; each task re-checks on its own day.

**Spec:**
- `docs/V0_1_PLAN.md`: §M7, §Multi-agent orchestration (all of it), §Exit gate, M1 conventions 8, 10–13.
- `docs/plans/roadmap-audit-2026-11-16.md`: §3.4 (LangGraph, cost, scope of M7), §4 M7 table, F9, F16, F19, §7 decision 12.
- `docs/plans/audit-m3-m4-plan-2026-11-16.md`: G8, G24.
- `docs/plans/m5-assembly-delivery.md` (`planRender`, step keys) and `docs/plans/m6-1-deterministic-critics.md` (`CriticFinding`, `RULES`).
- `docs/DESIGN_SPEC.md`: §Agent crew and contracts, §Orchestration model, §Gates and review, D5, D8, D9, D17, D25, D30, D31, D37, D38, D41.
- `AGENTS.md` §2.2 (prompts), §3 invariants 1, 2, 5, 8, 9, 11, 12, §4.3.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| **Decision 12: LangGraph (maintainer; a decision-log change)** | **Recommendation: amend D5 and D37 before Task 3 and do not build Task 3 in v0.1.** Proposed D5: "A runtime interface with a plain loop implementation in v0.1; LangGraph or Temporal adapters possible later." If the maintainer keeps D5 as written, Task 3 is built as specified and must pass the same suite. | With D37, the reconciler already gives resume, crash recovery and gate pauses from the IR. LangGraph would hold only a cache of that. What it adds in v0.1 is a second runtime to keep in parity, a native module (`better-sqlite3`) on the clean-machine path (M8.5), a peer dependency on `@langchain/core`, and an interrupt model in which a node "restarts … from the beginning" on resume. No exit-gate item needs it. The pin has already moved once in a week (1.7.4 to 1.7.5). Cost if wrong: Task 3 is one PR, and the interface makes it addable at any time. |
| **Typed role output, not raw ops** | Each role's model output is `{ output: <role schema>, decisions: [{ about: string[]; choice; citations }] }`. `toPatch(role, output, ir, task): Patch` is pure and owned by the engine. `decisions[].about` names entity ids or field paths; the runner maps them to op indexes. | A patch op's `value` is arbitrary JSON, and component props differ per component. Schema-constrained output needs closed objects, and the newest models reject a forced tool call, so a generic "emit ops" contract cannot be constrained. Typed output is also what D31 asks for. `V0_1_PLAN.md`'s "patch ops + decision entries" still holds at the store boundary. Cost if wrong: none at the store; the conversion functions are small. |
| No sampling control | The LLM interface has no temperature or seed. Reproducibility comes only from cassettes. | Current models reject sampling parameters (§External facts). A plan that assumed "temperature 0" for replay or for the vision critic would not run. |
| Entry points | `cinewright plan` starts or resumes a run and stops before paid production (after P7, at G2). `cinewright render` starts or resumes it through to the final gate. With preset `manual`, or `--jobs-only`, `render` is the M5.4b pipeline unchanged. Both call `runWorkflow`. They are wired in Task 1 as soon as there is a runtime; M8.1 documents them. | `V0_1_PLAN.md`'s command list has no command that starts an agent run, yet M7's criteria need one before M8. |
| Task identity | `Task = { id; key; kind: "agent" \| "job" \| "gate" \| "human"; phase; role?; step?; entities: string[]; deliverable?; needs: string[]; paid: boolean }`. A job task's `key` is the pipeline step key (M5). An agent task's `key` is the JCS hash of the role id and version, the role's read-scope slice at the current revision, the pack pin and the catalog hash. | "Idempotent tasks: the key is the hash of its type, inputs and plugin version." |
| How "inputs changed" is known without run state | An applied agent patch records `task: { key, context_hash, run }` (a new optional field on the patch and its log entry). The reconciler re-derives an agent task when a required output is `open`, or when the recorded key differs from the current one and the outputs are still `agent`. Outputs that are `user` or `locked` are never re-derived: the change becomes a warning and a gate item. | The record must be production state or deleting `runs/` would re-run every agent. The patch log is that state. This implements the §Invalidation table's last row. |
| Gates are IR state | A gate is passed when every field and list it names is `locked`. Approving applies one patch of `lock` ops as job author `gate.script`, `gate.storyboard` or `gate.final` (the store's existing gate names). An edit at a gate is an ordinary `user` patch, after which the gate task re-derives. | No approval lives in run state. |
| Stills before the storyboard gate | P7 runs the real `render` and `keyframes` steps for every shot. P8 after G2 is then a cache hit for every shot the gate did not change. The gate packet refers to stills by render key and file hash; they stay in the render cache. | M3.5 stills are copies of the cached render's frames, so a still needs the render. HyperFrames renders cost CPU time, not money, so "cheap before expensive" still holds for paid work. This settles audit G8: stills are reproducible from the IR (D33) and need not be in the CAS; the M3.5 wording "stored in the CAS" is dropped. Cost if wrong: a wait before G2 on long films; a stills-only render mode is a later optimisation of one step. |
| Roles as configuration | `settings.roles: { <role>: "agent" \| "human" }` (a new authorable map on the project; absent means the preset's default). A `human` role's task has kind `human`: it waits in the queue, and `cinewright tasks submit` sends the same typed output through the same validation, stamped `user`. | Invariant 9. |
| Presets | Data in `engine/presets.json`: for each of `auto`, `guided`, `directed`, `manual`, the gates that pause, the roles that run, and what an agent does on `user` fields (suggest). The engine has no `if preset ===`. | The table in §Gates and autonomy presets, as data. |
| Auto-approving the final gate | Only with `--approve-final`, which tier B uses. It is recorded as `gate.final` with the session id and a `reason` of `auto`. Interactive harnesses never pass it. **Proposed D41 addition:** `cinewright review approve` joins `patch approve` and `patch revert` as commands an agent harness never auto-approves; the tier B flag is the one named exception. | D41 names only the two patch commands; gates add a third approval surface. |
| LLM tiers and pins | `llm.generate` takes `tier: "frontier" \| "mid"` and an optional opaque `pin`. The plugin's `settings.json` maps tiers and pins to model ids. Which role uses which tier is `agents/roles/<role>/role.json`, overridable in `settings.providers.llm`. | D9: tier is configuration. The pin lets a benchmark baseline hold its critic model (D36) without a model name leaving the plugin. |
| Cassettes | A cassette is `{ request_hash, response }`, keyed by the JCS hash of the provider-neutral request (tier or pin, system text, message text, image hashes, schema). Modes `replay`, `record`, `off` from `CINEWRIGHT_CASSETTE_MODE`, the folder from `CINEWRIGHT_CASSETTES`. A miss in `replay` is a typed error naming the role, task and hash. Usage is kept; keys never are. | `AGENTS.md` §4.3. The request hash is the "context-pack hash" of `V0_1_PLAN.md`. |
| What replay needs to reproduce `state_hash` | Ids come from the recorded output. Take and music asset ids are derived from their request hash (`take_<line>_<8 hex>`), never random, and a re-take's seed is derived from the count of takes for that key. Providers are the stub or cassette plugins. **This binds M4.1a, which has not started: raise it there.** | `state_hash` covers asset entities. A random id in the narration job would make the M7 criterion unreachable. |
| Budget | `log/spend.jsonl`, append-only and tracked in git, one entry per paid call: task key, plugin, the model id the plugin reports, units, USD. Spent is the sum of the log. Before a paid task starts the scheduler reserves its estimate; if `spent + reserved + estimate > cap` the run pauses with a budget pause. `cinewright init` writes `budget.cap` from `engine/settings.json` (`default_budget_usd`); intake rejects a project with no budget. | D17. Spend must survive deleting `runs/`, and a fresh clone must not reset it, so it sits with the other logs. The default is an engineering limit, not taste. Cost if wrong: noisier diffs in `log/`. |
| Cost estimates | Each paid plugin offers `<kind>.estimate` (the same request → `{ usd_max }`). The manifest `cost_model` is the fallback. Actuals come from the response (`cost_usd`). | One `usd_per_unit` cannot describe input and output tokens. |
| Scopes per task | The store's scope check gains the task's entity ids: `apply(patch, { scope: { role, entities } })`. An op on an entity outside `entities` (or outside their subtrees) is rejected. An `insert` is also checked field by field against the role's paths. | F19. "One Shot Builder per shot" must be enforced by the store, not by the prompt. |
| Schema additions | All optional, so every existing project still validates (migrations arrive in v0.2): `project.plan`, `settings.roles`, `settings.workflow`, `patch.task`. `settings.providers` comes from M4. | No migration tool exists yet. |
| Prompts | `agents/roles/<role>/prompt.md` states craft principles and the role's contract only. A lint test fails on a colour, font family, easing, duration, pack id, component id, voice id, genre or model name in any prompt. Pack rules and the catalog reach the model as data in the context pack. | `AGENTS.md` §2.2 and §8. |

## Global Constraints

- **Invariants:** the IR is the only production state; agents write only `open` and `agent` fields; every agent patch carries decisions with resolving citations; any role can be `human`; no model name, vendor SDK or prompt aesthetic outside its allowed place.
- **No LLM call in required CI.** Every test uses stub agents (scripted typed outputs) or cassettes. Live runs are opt-in (`CINEWRIGHT_LIVE_TESTS=1` plus a key), capped by a test budget, and never run on forks.
- **Idempotent and resumable:** killing the process at any point and starting again reaches the same `state_hash` with stub agents, and pays for nothing twice.
- **Secrets** never appear in a context pack, cassette, event, ledger, decision or error.
- **Engineering limits are data:** retry counts, repair rounds, concurrency, token budgets and the default cap live in `engine/settings.json` or the project, with the values of `V0_1_PLAN.md` §Bounds as defaults.
- **Benchmark:** from the alpha gate on, every PR runs tier A; a change to prompts or roles also replays the agent cassettes.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.

## Review Focus

1. **Kill and resume in every phase.** With stub agents, a run killed once inside each of P1 to P12 (and inside a patch commit) and restarted ends with the same `state_hash` as an uninterrupted run, makes each stub call once, and records each paid stub call once in `log/spend.jsonl`. Deleting `.cinewright/runs/` between kill and restart changes nothing. Test: Tasks 1 and 2.
2. **An agent that steps outside its scope or its facts.** Output that touches another shot, a `user` field, a `locked` list, a field outside the role's paths, or cites a pack rule that does not exist is refused; the errors go back for at most two repairs; a blocked-by-authorship change is stored as a suggestion; nothing partial is applied. Test: Task 6.
3. **A human in an agent's seat.** With `writer: human`, the same workflow pauses with one task in the queue; the submitted script passes the same checks, is stamped `user`, and the run continues to the same later phases. Test: Task 7.
4. **The budget cap.** A run whose next paid task would cross the cap pauses before the call, with the amounts in the pause; raising the cap resumes it; deleting `runs/` does not lower spent. Test: Task 8.
5. **Replay.** Replaying the recorded cassettes for a brief reproduces the recorded `state_hash` at each gate, with zero provider calls; changing one character of a prompt is a cassette miss that names the role. Test: Tasks 5, 9, 10 and 11.

---

## Tasks

PR order: 1 → 2 → (4 and 5 in either order; 5 needs only 1) → 6 → (7 and 8 in either order; 8 needs 4) → 9 → 10 → 11. Task 3 only if decision 12 keeps LangGraph, any time after 2. M4 Task 12 (generative music) can land any time in this milestone. Each task is one PR.

### Task 1: Runtime interface, run ledger, event log, loop runtime (PR M7.1a)

**Files:** `engine/src/runtime/{types,loop,ledger,events}.ts`, `engine/schema/{task,run-ledger,event}.schema.json`, `engine/src/run.ts` (`runWorkflow`), `engine/test/{runtime,resume}.test.ts`, `engine/test/stubs/{agents,providers}.ts`, `core/src/project/layout.ts` (`runDir`), `cli/src/commands/{plan,render}.ts`, `cli/src/exit-codes.ts` (`paused: 11`).

**Interfaces:**
- `WorkflowRuntime = { run(ctx: RunContext, signal: AbortSignal): Promise<RunOutcome> }`.
- `RunContext = { store; runId; template; preset; derive(): Promise<Task[]>; execute(task): Promise<TaskResult>; ledger; events }`.
- `RunOutcome = { status: "done" } | { status: "paused"; pause: { kind: "gate" | "human" | "budget"; id: string } } | { status: "failed"; task: string; error: PluginError }`.
- `TaskResult = { status: "done" | "noop" | "failed" | "blocked"; revision?; cost_usd?; findings?; error? }`.
- Ledger line: `{ seq, task, key, kind, status: "started" | "done" | "failed", at, revision?, cost_usd? }`. Event line: `{ seq, at, run, type, task?, role?, plugin?, model?, input_hash?, context_hash?, tokens?, cost_usd?, ms?, outcome?, patch? }`.
- `runWorkflow(store, { until?: "storyboard" | "final"; runId?; jobsOnly?; approveFinal?; onEvent? }): Promise<RunOutcome>`.

- [ ] **Step 1: Write the failing tests** with a three-task toy template and stub executors.
  - The loop runs derived tasks in dependency order until none is left, and returns `done`.
  - A gate task returns `paused` with the gate id; calling `run` again after the stub approval continues.
  - A task that fails returns `failed` naming it; tasks that do not depend on it still ran.
  - The ledger and every event validate against their schemas; a planted secret appears in neither.
  - **Resume:** a process killed after `started` and before `done` re-runs that task; one killed after `done` does not.
  - `CINEWRIGHT_FIXED_TIME` makes ledger and events byte-stable.
  - CLI: `plan` on a paused run exits 11 and prints the pause; `--json` carries the outcome.
- [ ] **Step 2: Implement.** The loop: derive, drop tasks whose key the ledger marks done at the current revision, run the ready ones, repeat.
- [ ] **Step 3: Verify.** Full suite.
- [ ] **Step 4: Commit.**

### Task 2: Reconciler, workflow templates, P0 intake (PR M7.1b)

**Files:** `engine/src/reconcile/{reconcile,requirements,inputs}.ts`, `engine/schema/workflow-template.schema.json`, `engine/templates/{explainer,ad}.json`, `engine/presets.json`, `engine/src/intake.ts`, `core/schema/{project,patch,log-entry}.schema.json` (`settings.workflow`, `settings.roles`, `patch.task`), `core/src/project/init.ts` (`--workflow`, default budget), `engine/settings.json`, tests.

**Interfaces:**
- Template: `{ id, version, phases: [{ id, kind: "agent" | "jobs" | "gate", role?, steps?: StepKind[], per?: "project" | "sequence" | "shot" | "line" | "deliverable", requires: string[] (field patterns that must be filled), needs: string[] (phase ids), locks?: string[] }] }`.
- `reconcile(ir, template, preset, plan: RenderPlan | null, recorded: Map<string, string>): Task[]`, pure. `recorded` maps a task id to the key stored with the patch that last filled its outputs.
- `intake(ir, template, registry): Finding[]`: `intake.no_budget`, `intake.no_deliverable`, `intake.unsupported` (a shot type, transition or capability v0.1 cannot route, naming the entity), `intake.no_provider` (a role or job with no installed plugin).

- [ ] **Step 1: Write the failing tests.**
  - **One path:** for the alpha fixture with its script unset, then its shots unset, the task set is the Writer task, then the Director task. A user patch that fills the field removes the task. A restart with an empty `runs/` gives the same set.
  - **Inputs changed:** editing a line the Director read re-derives the Director task while its outputs are `agent`; after G2 locks them it derives nothing and emits `reconcile.locked_upstream` as a warning.
  - **Job tasks** are exactly `planRender`'s steps with the same keys.
  - **Fan-out:** one Shot Builder task per shot with open layers; none for a shot whose layers are filled.
  - **Presets:** `guided` yields three gate tasks, `auto` one, `directed` two and no Writer task when the script is user-authored, `manual` no agent task at all.
  - **Templates** validate; `ad` differs from `explainer` only in data.
  - **Intake:** each of the four findings, each naming its entity; the spec's scene example (with `generative_footage` and `match_cut`) is rejected by name.
  - **Kill and resume (Review Focus 1)** over the full explainer template with stub agents and stub providers.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** The M1 reference build and every existing fixture still validate with the schema additions; `gen:check` passes.
- [ ] **Step 4: Commit.**

### Task 3: LangGraph runtime (PR M7.1c — only if decision 12 keeps D5)

**Files:** `engine/src/runtime/langgraph.ts`, `engine/package.json`, tests.

- [ ] **Step 1: Re-verify** the pinned versions and the interrupt rules on the task's day (§External facts).
- [ ] **Step 2: Write the failing tests.** The Task 1 and Task 2 suites, parameterized over both runtimes, pass unchanged. A gate is one node that only interrupts, with every side effect in other nodes, so a resume that re-enters the node repeats nothing. Deleting the checkpoint file between pause and resume loses nothing.
- [ ] **Step 3: Implement.** One graph per template; the checkpointer writes under `.cinewright/runs/<run>/`. `CINEWRIGHT_RUNTIME=loop|langgraph` selects.
- [ ] **Step 4: Record** in the PR what the LangGraph runtime gives that the loop does not. If the answer is nothing, close the PR and amend D5.
- [ ] **Step 5: Commit.**

### Task 4: Scheduler (PR M7.2)

**Files:** `engine/src/scheduler/{scheduler,limits,retry,fallback,pool}.ts`, `engine/src/plugins/route.ts` (`routeCapability`), tests with a fake clock.

**Interfaces:**
- `Scheduler.run(tasks: Task[], execute: (t: Task, plugin?: LoadedPlugin) => Promise<TaskResult>, signal): Promise<Map<string, TaskResult>>`.
- `routeCapability(capability: string, ir, options: { pinned?: string; exclude?: string[] }): LoadedPlugin[]`, in preference order (the M4 rule: settings, then free, then paid with secrets present, then id).
- Limits per plugin from its manifest (`concurrency.max_parallel`, `rate_limits`); the render pool size is `min(cpus, settings.render_pool)`.

- [ ] **Step 1: Write the failing tests.**
  - Two tasks with one key run once; both callers get the result.
  - Never more than `max_parallel` calls in flight per plugin; the rate limit is honoured on the fake clock.
  - A retryable error is retried with exponential backoff up to 3 attempts; a non-retryable one is not.
  - After the attempts, the next plugin with the capability is tried unless one is pinned; with a pin, the task fails as `blocked` and the run pauses.
  - Renders for two deliverables of one shot run in parallel up to the pool size; the cache commit rule (M5) holds.
  - Abort stops queued tasks and cancels running ones.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Tier A wall time with the pool, recorded in the PR.
- [ ] **Step 4: Commit.**

### Task 5: LLM interface, reference plugin, cassettes, boundary rules (PR M7.3)

**Files:** `plugins/sdk-ts/src/kinds/llm.ts`, `plugins/sdk-ts/schema/kinds/llm.schema.json`, `plugins/sdk-ts/test/fixtures/stub-llm/`, `plugins/llm-anthropic/{manifest.json,package.json,settings.json,src/{index,plugin,request,schema,cost}.ts,test/{…,cassettes/},README.md}`, `engine/src/agents/cassette.ts`, `tools/src/cinewright_tools/boundaries.py` and its tests.

**Interfaces:**
- `llm.generate`: `{ tier: "frontier" | "mid"; pin?: string; system: string; messages: { role: "user" | "assistant"; content: ({ type: "text"; text: string } | { type: "image"; file: string; hash: HashString; media_type: string })[] }[]; schema: JsonObject; max_output_tokens: number; effort?: "low" | "medium" | "high" }` → `{ output: unknown; model: string; usage: { input_tokens; output_tokens; cached_tokens? }; cost_usd: number; stop: "end" | "max_tokens" }`.
- `llm.estimate`: the same request → `{ usd_max: number }`.
- Errors: a refusal is `provider_error`, not retryable, with `data.category`; 429 is `rate_limited`; 5xx and network are retryable `provider_error`; a schema the provider cannot take is `invalid_request`.
- `providerSchema(schema): JsonObject` in the plugin: reduces a JSON Schema to the provider's supported subset. The runner always validates against the full schema afterwards.
- `withCassettes(plugin, { dir, mode }): Plugin`; `requestHash(request): HashString`.

- [ ] **Step 1: Re-verify the provider API** on the task's day and record it in the README: the structured-output parameter and schema limits, image size limits, which request fields current models reject, the refusal signal, the usage fields and prices.
- [ ] **Step 2: Write the failing tests.**
  - **Conformance:** the LLM kit accepts the stub and the plugin under cassette replay.
  - **Structured output:** a recorded response parses to schema-valid output; `providerSchema` closes every object and drops unsupported keywords, and the full schema still catches a violation the reduced one allows.
  - **Tiers and pins:** the model id sent comes from `settings.json`; an unknown pin is `invalid_request`; the response reports the model used.
  - **Errors:** each mapping above; the key is in no error, cassette or log.
  - **Cassettes (Review Focus 5):** `replay` serves a hit with no network; a miss names the hash; `record` writes a file whose hash matches; an image is hashed by content, not by path.
  - **Boundary rules (F16):** a model-id pattern or an `@anthropic-ai/*` import outside `plugins/llm-anthropic/` fails `cinewright-check-boundaries`; docs and plans are exempt.
  - **Live test:** opt-in, one short request, capped.
- [ ] **Step 3: Implement** with the vendor's official SDK, inside the plugin.
- [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit.**

### Task 6: Agent runner and the role table (PR M7.4)

**Files:** `agents/{package.json,roles/README.md,craft-rules.json,schema/role.schema.json,src/index.ts,test/prompt-lint.test.ts}`, `engine/src/agents/{runner,context,validate,citations,repair}.ts`, `core/src/store/{scopes,store}.ts` (task entities, inserted subtrees), `core/test/store/scopes.test.ts`, `engine/test/agents/…`.

**Interfaces:**
- `role.json`: `{ id, version, tier, reads: string[] (read-scope selectors), writes: { kinds: string[]; paths: string[] }, per: "project" | "sequence" | "shot", token_budget, repairs: 2 }`, with `prompt.md` and `output.schema.json` beside it.
- `buildContextPack(ir, role, task, extras: { pack; catalog; findings? }): ContextPack`; `ContextPack = { system: string; sections: { id: string; text: string }[]; images: { file; hash }[]; schema: JsonObject; hash: HashString }`.
- `validateOutput(role, output, ir, task): ValidationError[]` (schema, then role-specific semantic checks).
- `resolveCitations(decisions, { ir, pack, craftRules, findings }): ValidationError[]`. Forms: `brief`, `user_instruction:<log seq>`, `pack_rule:<pack>/<rule>`, `craft_rule:<id>`, `finding:<id>`.
- `runAgentTask(task, deps: { store; llm; role; toPatch; scheduler }): Promise<TaskResult>`.
- Store: `apply(patch, { scope?: { role: string; entities: string[] } })`.

- [ ] **Step 1: Write the failing tests** with a stub LLM and a toy role.
  - **Context pack:** it holds only the read scope's slice, with resolved values and origins; the same IR gives the same hash; it exceeds no token budget (a fixture over budget fails with the section named).
  - **Scope and authorship (Review Focus 2):** each of the five violations.
  - **Inserted subtree:** an inserted shot carrying a field outside the role's paths is rejected, naming the field.
  - **Repair:** invalid output is returned to the model with the error list; valid output on the second try is applied; a third failure ends the task as `failed` with the errors in the event.
  - **Conflict:** a store conflict rebuilds the pack on the new revision and retries once; a second conflict is `blocked`.
  - **Decisions:** the applied patch has one decision per `about` group with resolving citations and `task.key` and `task.context_hash` set; `log/decisions.jsonl` gains the entries.
  - **Craft rules:** every id cited by a prompt exists in `craft-rules.json`, and each rule is a sentence about hierarchy, contrast, rhythm, continuity, legibility or intelligibility.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** The M1.4b scope tests still pass.
- [ ] **Step 4: Commit.**

### Task 7: Gates, presets and the human task queue (PR M7.6)

**Files:** `engine/src/gates/{packet,decide,variants}.ts`, `engine/schema/gate-packet.schema.json`, `engine/src/tasks/queue.ts`, `cli/src/commands/{review,tasks}.ts`, `cli/README.md`, `docs/DESIGN_SPEC.md` (D41, if approved), tests.

**Interfaces:**
- `buildPacket(store, gate, run): GatePacket`; `GatePacket = { gate; revision; diff: { entity; path; before; after }[] (since the last approval of this gate); locks: { entity; path }[]; suggestions; findings: CriticFinding[]; stills?: { shot; deliverable; frame; file; sha256; render_key }[]; cost: { spent_usd; estimate_to_complete_usd; cap_usd } }`.
- `approveGate(store, gate, { auto?: boolean }): Promise<ApplyResult>`; `rejectGate(store, gate, note): Promise<void>` (the note becomes a pending instruction with a log sequence that agents cite as `user_instruction:<seq>`).
- `requestVariants(store, gate, entity, n): Promise<Variant[]>`: N alternative typed outputs for one line, beat or scene, stored in the run folder; `chooseVariant` applies one as a `user` patch.
- CLI: `review [--json]`, `review approve <gate>`, `review reject <gate> --note <text>`, `review variants <gate> --entity <id> [--n 3]`, `review choose <variant>`; `tasks [--json]`, `tasks show <id>`, `tasks submit <id> --file <output.json>`.

- [ ] **Step 1: Write the failing tests** with stub agents.
  - **Locks per gate:** G1 locks line text and the beat and line lists, and a locked line still receives a take; G2 locks scenes, the shot list, shot types, layout templates, component choices and transitions, and leaves layer props `agent`; G3 locks the project.
  - **Packet:** the diff since the last approval, open suggestions, findings, stills by hash and the three cost figures; it validates; a missing still is rebuilt from the IR.
  - **Edit at a gate:** a user patch to a line makes the field `user`, re-derives narration and timing for that scene, and the gate pauses again.
  - **Reject with a note:** the owning role's next context pack carries the note, and its decision cites it.
  - **Variants:** three stored, none applied; choosing one applies it as `user`.
  - **Human seat (Review Focus 3).**
  - **Four presets** on one brief: the gates that pause match `presets.json`; `manual` turns findings into suggestions and applies no agent patch.
  - **Approval authority:** `review approve` as an `agent` author is refused; `--approve-final` is recorded with reason `auto`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

### Task 8: Cost ledger and budget cap (PR M7.7)

**Files:** `engine/src/cost/{ledger,estimate,reserve}.ts`, `core/src/project/layout.ts` (`SPEND_LOG = "log/spend.jsonl"`), `core/schema/spend-entry.schema.json`, `engine/src/scheduler/scheduler.ts` (reservation hook), `cli/src/commands/review.ts` (`review budget --cap <usd>`), `cli/src/exit-codes.ts` (`budget: 12`), tests.

**Interfaces:**
- `SpendEntry = { seq; at; run; task; key; plugin; model?; unit; units; usd }`.
- `spent(projectDir): number`; `record(projectDir, entry)` under the store lock.
- `estimateRun(ir, template, registry, plan): Estimate`; `Estimate = { phases: { id; usd }[]; fix_reserve_usd; total_usd }`.
- `reserve(task, usd): { ok: true; release(actualUsd) } | { ok: false; pause: { spent; reserved; needed; cap } }`.

- [ ] **Step 1: Write the failing tests** with priced stub plugins.
  - The estimate covers every paid task and the fix reserve, and is recomputed in each gate packet.
  - **Cap (Review Focus 4).**
  - Reservations of parallel tasks add up: three tasks that fit singly but not together run two and pause.
  - A failed call records what the provider charged, or nothing if it reported nothing.
  - The spend log validates, is append-only (a rewritten line fails load), and holds no secret.
  - An estimate over the cap at P1 pauses at the budget gate before the Writer runs.
  - A free-only setup (local TTS, library music, stub LLM) records zero and never pauses.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Confirm the store's load check accepts the new file in `log/` (it must not be read as an out-of-band edit).
- [ ] **Step 4: Commit.**

### Task 9: Producer and Writer (PR M7.5a)

**Files:** `agents/roles/{producer,writer}/{role.json,prompt.md,output.schema.json}`, `engine/src/agents/roles/{producer,writer}.ts` (`toPatch`, semantic checks), `core/schema/project.schema.json` (`plan`), `engine/test/agents/cassettes/…`, `fixtures/benchmark/tier-b/_dev/brief_01/` (one neutral development brief).

**Interfaces:**
- Producer output: `{ plan: { summary; target_seconds; beats: string[] }; pack?: string }`. It writes `project.plan`, and `style.pack` only while that field is `open`.
- Writer output: `{ beats: [{ id; summary; lines: [{ id; text; direction?; on_screen_text? }] }] }`. Every line's speaker is the narrator.
- Script checks (P2): the duration estimated from `pace_wpm` fits the target within flex and the deliverable's `max_duration` when set; on-screen text is within the pack's density limits; ids are valid and unused.

- [ ] **Step 1: Write the failing tests** with stub outputs: `toPatch` for both roles; a too-long script fails the check and is repaired; a Producer that names a pack not installed is refused; with `style.pack` set by the user the Producer's choice is dropped and a suggestion stored.
- [ ] **Step 2: Write the prompts**, and pass the prompt lint.
- [ ] **Step 3: Record cassettes** against the live provider for the development brief under both packs, within the test budget. Note the cost in the PR.
- [ ] **Step 4: Replay tests (Review Focus 5):** the brief runs to the script gate; the `state_hash` at G1 equals the recorded one; the decision log cites the brief or a pack rule for every decision.
- [ ] **Step 5: Verify and commit.**

### Task 10: Director (PR M7.5b)

**Files:** `agents/roles/director/…`, `engine/src/agents/roles/director.ts`, cassettes.

**Interfaces:** output `{ sequences: [{ id; title?; mood; music_bed?; scenes: [{ id; intent; mood; lines: string[]; duration: { target_seconds; flex; sync }; transition_out: { type; duration_frames? }; sound?: { sfx: string[] }; shots: [{ id; type; framing?; anchors: { start: Anchor }; layout: Record<AspectClass, { template: string }>; components: string[] }] }] }] }`. `components` is the Director's choice per shot, written as layer stubs (id and component only) for the Shot Builder to fill.

- [ ] **Step 1: Write the failing tests** with stub outputs: every line is covered by exactly one scene (a missed or doubled line is refused, naming it); every shot type and transition is routable in v0.1; a layout template exists in the pack for each deliverable's aspect class; every component is in the catalog; shot start anchors tile each scene under the solver with no `timing.uncovered`.
- [ ] **Step 2: Prompt and lint.** One call per project up to `settings.director_max_lines`, then one per sequence.
- [ ] **Step 3: Record and replay** for the development brief, both packs: the run reaches P5 with a valid scene plan; `state_hash` matches.
- [ ] **Step 4: Verify and commit.**

### Task 11: Shot Builder and Editor (PR M7.5c)

**Files:** `agents/roles/{shot_builder,editor}/…`, `engine/src/agents/roles/{shot_builder,editor}.ts`, `engine/src/agents/schema/layers.ts` (the per-shot output schema built from the catalog), cassettes.

**Interfaces:**
- Shot Builder output, per shot: `{ layers: [{ id; component; props; motion?: [{ preset; params? }]; timing: { enter: Anchor; exit?: Anchor }; layout: Record<AspectClass, { region: string }>; style?: { overrides: Record<string, { token: string }> } }] }`. The schema offered to the model is a union over the shot's chosen components, each with its own props schema; token references are the only style values allowed.
- Editor output: `{ scenes: [{ id; duration?: { target_seconds; flex }; transition_out?: { type; duration_frames? } }]; shots?: [{ id; anchors: { start: Anchor } }] }`. The solver, not the Editor, produces spans (M4: spans are derived and never written).

- [ ] **Step 1: Write the failing tests** with stub outputs: props validate against the component schema and compile succeeds, within two repair rounds; a literal colour where a token reference is required is refused; a Shot Builder patch touching another shot is refused by the store; the Editor's changes clear a seeded `timing.short_hold` and a seeded `timing.overrun`; after G2 an Editor change to a locked transition becomes a suggestion.
- [ ] **Step 2: Prompts and lint.**
- [ ] **Step 3: Record and replay** for the development brief, both packs: the run reaches G2 with stills, then G3 with a film that passes every deterministic check, or else every remaining finding is listed in the PR as input to M6.3. `state_hash` matches at each gate.
- [ ] **Step 4: One live run** in the Auto preset to the first gate, capped, recorded in the PR (the "with real agents" criterion).
- [ ] **Step 5: Verify and commit.**

## External facts (checked 2026-11-20)

- **LangGraph.js:** `@langchain/langgraph` 1.7.5 (MIT, Node ≥ 18; peers `@langchain/core` ^1.3.4 and `zod`); `@langchain/langgraph-checkpoint-sqlite` 1.1.1 (depends on `better-sqlite3` ^12.10.0). `V0_1_PLAN.md` records 1.7.4 and 1.1.0. An interrupt needs a checkpointer and a thread id; resuming with `Command({ resume })` "restarts the entire node from the beginning"; side effects before an interrupt "should (ideally) be idempotent"; resume values match interrupts by index, so calls must keep their order. Sources: [npm `@langchain/langgraph`](https://registry.npmjs.org/@langchain/langgraph/latest) · [checkpoint-sqlite](https://registry.npmjs.org/@langchain/langgraph-checkpoint-sqlite/latest) · [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) · [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence). *Not verified:* when checkpoints are written within a step, and any durability setting.
- **Claude API** (from Anthropic's current developer reference, cached 2026-11-03; re-check in Task 5): JSON-schema-constrained output is requested with `output_config.format`, and strict tool input with `strict: true`; both require `additionalProperties: false` on every object and accept a subset of JSON Schema. The newest models reject a forced tool choice, reject `temperature`, `top_p` and `top_k`, and reject assistant prefill. A safety decline is a normal response with a `refusal` stop reason. Structured output cannot be combined with citations. *Not verified here:* the full list of unsupported schema keywords and the image size limits per model.

## Done when (M7 acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| M7.1a: with stub agents and the loop runtime, a run reaches the end of the explainer template; ledger and log validate | Tasks 1 and 2 |
| M7.1b: tasks derive from IR state alone; a human edit, an agent patch and a restart give the same task set; intake rejects a missing budget or an unsupported capability | Task 2 |
| M7.1c: the same tests pass on the LangGraph runtime; deleting checkpoints loses nothing | Task 3, or decision 12 amends D5 |
| A run pauses at each gate, resumes, and survives a kill in every phase | Tasks 1, 2 and 7 (loop runtime) |
| M7.2: idempotency keys; limits from manifests; backoff; fallback; render pool | Task 4 |
| M7.3: structured output; tiers are configuration; cassettes keyed by context-pack hash; model-name boundary rule | Task 5 |
| M7.4: context packs from read scopes; output validated for schema, scope, authorship and citations; per-task entity scopes and inserted-subtree checks; repair loop; one conflict retry | Task 6 |
| M7.5a: a brief runs to the script gate; cassette replay reproduces the `state_hash` | Task 9 |
| M7.5b: every line covered by one scene; every shot type routable | Task 10 |
| M7.5c: props validate; compile succeeds within two repair rounds | Task 11 |
| M7.6: four presets; gate packets; any role set to `human` runs the same workflow | Task 7 |
| M7.7: estimate, reservations, fix reserve; a run pauses before crossing the cap; spend survives deleting `runs/` | Task 8 |
| With real agents, a brief runs autonomously to the first gate | Task 11 Step 4 |
| Invariants 8, 9, 11 and 12 | Tasks 5, 6, 7 and 11 |
