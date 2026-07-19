# Watchdog — Project Handoff

Read this first in a fresh session. Keep it current, compact, and forward-looking: replace stale facts instead of appending history.

## Working rules

- Run `git status --short` before editing. The dirty tree contains valuable uncommitted work.
- Preserve unrelated user changes. Never reset or discard the worktree.
- Use Bun for local development. Published output must run on ordinary Node.js 22 without Bun.
- Use `apply_patch` for edits.
- Do not commit, push, publish, or choose a license/package name without explicit permission.
- Preserve user-tuned pixel assets, train smoke/chimney coordinates, and mascot animations unless the task specifically concerns them.
- Update this file after a material product decision, validation, technical discovery, or scope change.
- The 2026-07-20 cleanup is complete. Keep the same standard: remove only demonstrably redundant code, dependencies, package bytes, or low-value tests; preserve behavior and compatibility, and measure meaningful reductions.
- The public repository now has roughly 100 active users relying on it. Treat every change as production work: preserve CLI/event compatibility, replay old traces safely, degrade gracefully, and do not expose partially wired behavior.

## Product

Watchdog is an OpenAI Build Week developer-tooling project. Optimize for a credible winning demo and a sharp product wedge, not breadth.

Build a **local-first, harness-agnostic operator control plane for subagents, agentic loops, and execution graphs**.

Harness order:

1. Codex — implemented and the primary OpenAI hackathon surface.
2. Pi — implemented and the strongest proof that the control plane is genuinely cross-harness.
3. Claude Code — especially relevant now that it exposes script-defined dynamic workflows.
4. OpenCode and others later.

“Cross-harness” means separate runs from different harnesses share one normalized model and control surface. It does not mean sending one prompt through multiple harnesses.

Watchdog is not another harness, a replay-only log viewer, a terminal multiplexer, a remote-process manager, or a broad SaaS platform. Herdr, Agents Trail, Codex `/subagents`, and native harness UIs already cover parts of those spaces. Watchdog’s wedge is **live, capability-aware intervention across branching and repeating execution**.

The demo must show more than a tree: detect or explain a bad orchestration state, reveal its cost/configuration consequences, and intervene truthfully.

## Core model

These concepts intersect but are not interchangeable:

- **Subagent topology:** ownership—who spawned whom. This is usually a rooted tree.
- **Execution graph:** directed control/data/dependency flow among tasks, agents, tools, gates, verifiers, events, and subgraphs. It can fork, join, hand off, branch conditionally, or remain acyclic.
- **Loop:** repeated traversal of a node or subgraph until an exit condition passes. In graph terms, this is a cycle/back-edge plus iteration, verifier, and budget state.
- **Workflow:** a reusable executable graph definition. A script or runtime, rather than an agent’s conversational context, owns what runs next and where intermediate results live.

There is no universal `PLAN → EXECUTE → VERIFY → DONE` loop. Node labels and edges must come from an authoritative harness/workflow, explicit Watchdog instrumentation, or an operator declaration. If only the outer loop is known, represent its attempt body honestly as opaque; heuristics may label a suspected loop but must never invent precise stations.

Example:

```text
Root
 ├─ Researcher ─┐
 └─ Tester ─────┴─→ Verifier
                       │ fail
                       └────→ retry Researcher
```

This contains a subagent tree, a parallel fork/join, a verifier, and a loop.

### Graph direction

The user-provided Claude Code dynamic-workflow documentation is a strong design signal:

- a JavaScript script defines repeatable orchestration;
- `agent()` creates work nodes and `pipeline()` fans work across inputs;
- script variables hold intermediate results;
- phases/agents expose status, tokens, elapsed time, pause/resume/stop/restart;
- scripts can be saved and rerun.

Pi’s lead developer separately described the underlying object as a directed graph and suggested external events should trigger whole subgraphs.

Watchdog should model this without immediately becoming another workflow engine:

1. Observe and normalize graph definitions/runs from harnesses that expose them.
2. Add a small explicit instrumentation surface when a harness has no authoritative graph primitive.
3. Represent external/manual events as triggers that create graph or subgraph activations.
4. Consider execution/SDK features only after the observation/control model is sound.

A useful split is:

- `GraphDefinition`: reusable nodes, directed edges, triggers, gates, subgraph references, and declared budgets.
- `GraphRun`: one activation with node attempts, statuses, inputs/outputs, iteration IDs, evidence, tokens/cost, timestamps, and controls.

Likely node kinds: agent, task, tool, verifier/gate, event, and subgraph. Likely edge kinds: dependency, control, data, conditional, and back-edge.

### Graph implementation status

Watchdog now has a first-class additive execution model:

- named graph definitions with entry/terminal nodes, directed typed edges, authority/source, and parent execution/node links;
- node attempts, concurrent active nodes, edge traversals, iteration events, completion state, and owner-thread correlation;
- `loop-back` edges identify cycles without assuming every execution is a loop;
- `subgraph` nodes open nested executions;
- legacy `loop` commands translate to the honest generic cycle `ATTEMPT → VERIFY → DONE`;
- lower-authority inferred/legacy definitions cannot overwrite authoritative ones;
- malformed edges, duplicate IDs, invalid subgraph links, and invented nodes are rejected.

The model is additive: old event traces still replay and snapshots from older running Watchdog versions are normalized with `executions: []`. Explicit graph events remain in the append-only trace.

Pi exposes this through `watchdog_execution`, available to the root and to every scoped worker. CLI/scripts/adapters can use `watchdog execution declare/update/start/finish-node/edge/finish`.

Codex now receives the same `watchdog_execution` surface through a run-scoped stdio MCP server configured on the Watchdog-owned App Server. The launcher generates the run ID before starting the App Server, injects ephemeral `-c mcp_servers.watchdog.*` settings there, and starts the control socket with the same ID. It does not modify global/project Codex config. Only the metadata tool is allow-listed and pre-approved; it cannot edit files or control agents. Configure it on the App Server, not the `codex --remote` frontend—the remote frontend's MCP config does not become a backend thread tool. Do not claim Codex automatically infers arbitrary graph boundaries.

The public `loop set/evidence/verify` commands are still needed for verifier, evidence, token-budget, and iteration-budget semantics plus old-trace compatibility. Do not remove them until the execution model has equivalent policy/proof fields and a migration path.

External triggers are not implemented yet.

## Architecture

```text
Codex CLI --remote ↔ Codex App Server + Watchdog MCP ↔ Codex adapter ┐
                                                                    ├→ normalized events
Pi TUI + extension ↔ Pi root/RPC workers ↔ Pi adapter ┘        ↓
                                                        RuntimeState
                                                             ↕
                                                  per-run control socket
                                                             ↕
                                             CLI / Ink / dashboard bridge
                                                             ↕
                                                   React/Vite dashboard
```

- TypeScript end to end.
- `HarnessAdapter` is the cross-harness seam. UI and policy code consume normalized events/capabilities, not harness protocol types.
- In-memory live state plus append-only `.watchdog/runs/*.jsonl`; no database yet.
- Every run gets a unique ID, a private hashed Unix socket under `/tmp/watchdog-<uid>/`, and an atomic registry entry under `~/.watchdog/registry/`.
- One dashboard normally serves `127.0.0.1:4242` and switches among independent runs. It never merges unrelated roots.
- React Ink powers the TUI. React + Vite + intentional plain CSS power the browser UI. Do not introduce Next.js, Tailwind, or OpenTUI for the MVP.
- `tsup` bundles the npm CLI and Pi extension for Node 22.

Important locations:

```text
src/adapters/events.ts       normalized event union
src/adapters/types.ts        adapter/capability contract
src/codex/                   Codex protocol, adapter, JSONL observer
src/pi/                      Pi extension, RPC, manager, coordinator
src/execution/               graph types, validation, cycle semantics
src/runtime/state.ts         normalized agent/loop state and warnings
src/runtime/control.ts       local controls and run selection
src/runtime/registry.ts      global active-run registry
src/server/dashboard.ts      dashboard catalog/control bridge
src/tui/                     Ink UI
web/src/App.tsx              dashboard, Operator, inspector
web/src/YardCanvas.tsx       pixel Yard
web/public/assets/           tuned raster assets
```

## Implemented surfaces

- `watchdog codex` owns a loopback Codex App Server and launches the normal Codex TUI with `codex --remote`.
- `watchdog observe` tails ordinary Codex session JSONL every 500 ms as a read-only fallback.
- `watchdog pi` launches normal Pi with the bundled Watchdog extension.
- CLI: `runs`, `ps`, `tree`, `inspect`, `steer`, `follow-up`, `stop`, `retry`, `loop set/evidence/verify`, `tui`, `dashboard`, `demo`, and `doctor`.
- CLI also exposes `execution declare/update/start/finish-node/edge/finish` for adapters and scripts while preserving legacy loop commands.
- Ink TUI: pane-aware agent selection, independently scrollable inspector, capability-derived control hints, and explicit execution/node summaries.
- Browser: live Yard, semantic/nested execution stations with breadcrumbs, exact graph edges in Operator, resizable inspector, session picker, adapter identity, controls, `/demo`, empty live Yard, day/night mode, and `/reveal`.
- State includes recursive agents, tasks/roles, live/completed messages, activity, requested/effective model and effort, tokens, Pi provider cost, first-class execution graphs/activations/traversals, explicit loop objective/phase/iteration/verifier/evidence/budgets, and capabilities.
- Multi-run selection uses the only run in the cwd or explicit `--run <id-prefix>` when ambiguous.

## Capability truths

Controls must always be adapter- and state-aware. Never display or claim a capability the live adapter cannot perform.

### Codex

- A Watchdog-owned App Server provides live root/child events, output, activity, token updates, and topology. `parentThreadId` from `thread/read` is the topology source of truth.
- Root steer, interrupt, and retry work when current turn IDs are valid.
- Native multi-agent-v2 children accept direct interrupt but reject direct steer/start. They are stop-only today.
- In a real 2026-07-19 `multi_agent_v1` rehearsal, the root could spawn children but a spawned child received Watchdog MCP instrumentation with no nested-agent spawn tool. Do not ask a Codex child to create a grandchild unless its live tool surface actually exposes delegation. Nested execution graphs can still be real while the root orchestrates their steps; Pi supports true nested worker delegation.
- Stopping a first-level child can wake/notify the root automatically. Nested-child notification must distinguish direct-parent notification from root-only notification.
- Requested child model/effort and effective child model/effort are separate. Natural-language model requests are not reliable; real runs have exposed mismatches.
- A tested runtime allowed four collaboration slots including the root, so only three concurrent children started. Treat this as a version/session fact, not a permanent product limit.
- `watchdog codex` must never print live event lines after the native TUI starts; doing so corrupts its full-screen renderer.
- A separate App Server is not a global bus for unrelated Codex sessions. Persisted JSONL observation remains read-only.
- Local controls, dashboard snapshots, and Codex RPC calls have bounded deadlines. Do not remove them.

### Pi

- Pi has no bundled native-subagent primitive. Watchdog supplies persistent `pi --mode rpc --no-session` workers while Pi remains the harness.
- Workers support live messages/tools, tokens/provider cost, steer, follow-up, stop, retry, model/thinking overrides, and nested delegation.
- Active Pi follow-up uses Pi’s queue; idle follow-up starts a context-preserving turn. Retry is serialized so stale cleanup cannot overwrite the new turn.
- Pi root retry is not truthfully exposed by the extension API; do not advertise it.
- A waiting nested parent yields its concurrency permit while children run, preventing parent-wait deadlocks.

Pi delegation is least-privilege:

- every worker loads only the Watchdog extension and receives an opaque scoped credential for reporting its own execution events;
- instrumentation credentials never grant delegation;
- default workers do not receive the `subagent` tool;
- nested permission requires explicit `allowDelegation: true`;
- lifetime `maxChildren` and descendant `maxDepth` both default to 1;
- an opaque per-worker token establishes coordinator identity; caller-supplied parent IDs are not trusted;
- list/control operations from a worker are confined to its own subtree;
- global defaults remain 12 workers, 4 concurrent model runs, and depth 3.

This policy was added after a real broad audit unexpectedly produced 11 workers because every child had inherited the subagent tool. The exact same natural-language audit now produces only:

```text
root → Scout → Nested
     ↘ Verifier
```

## UI non-regressions

- The Yard is the memorable default; Operator is the dense debugging view.
- Ordinary tasks render `START → END`. Explicit executions render their real node labels; a graph with `loop-back` edges is a loop. Do not imply every turn is a loop.
- Large graphs use an honest stable projection with an explicit `+N` collapsed station. Never silently omit nodes or invent names.
- `subgraph` stations are interactive. Opening one shows the child execution as a local Yard and preserves a clickable parent breadcrumb.
- Operator shows exact named nodes/edges separately from the recursive subagent topology. Do not call an agent tree the execution graph.
- The fixed pixel world is 1100×680 with contain scaling and centered letterboxing. Hit-testing must invert the same transform.
- The full-body German shepherd stays visible and pettable. Petting has a fixed baseline, small white hearts, no tooltip, and no sound.
- Train count is dynamic. The right-facing root uses a mirrored sprite with compensated selection brackets and nameplate; keep both on the same X offset.
- Children alternate above/below the main line on perpendicular spurs; working children stay at their outer positions, while completed children dock near the visible main-rail edge with 10px clearance calculated from the scaled sprite/nameplate bounds and remain inspectable.
- Smoke is a separate animation. Preserve user-tuned chimney/smoke anchors.
- The empty `/` route retains the Yard and confused dog but no trains. `/demo` must remain explicitly simulated. `/reveal` is runtime-independent.
- Clicking a child opens child-first details: assignment, activity, live response/history, tokens/config, then parent-loop context. Long content must wrap.
- The desktop inspector splitter persists width under `watchdog.inspector-width`; Left/Right/Home/End adjust it and double-click resets it. At 980px and below, the inspector stacks without overwriting desktop preference.
- Requested configuration says `no override` / `default effort`, not `not exposed`.
- Completed-message history retains the newest 100 per agent in memory; full completed history remains in JSONL. Streaming deltas are not logged individually.
- Preserve all raster assets unless replacement is explicitly requested and visually compared.

## Verification and repository state

Commands:

```bash
bun install
bun run dev -- codex
bun run dev -- pi
bun run dashboard
bun run dev -- runs
bun run dev -- tree --run <id-prefix>
bun run dev -- tui --run <id-prefix>

bun run check
bun run test
bun run test:web
bun run build
bun pm pack --dry-run
```

Latest verified state on 2026-07-20:

- TypeScript checks pass, including strict unused-local/parameter checks.
- 59 unit tests across 18 files pass.
- 2 Playwright browser tests pass.
- Production build and package dry-run pass; unpacked package is about 7.82 MB across 31 files, down from 8.77 MB/46 files without changing rendered Yard assets.
- The remaining package weight is intentional: about 7.57 MB is the built dashboard, dominated by the tuned raster art. Do not resize/re-encode it without visual comparison.
- Release source maps and one unreferenced 1,254px logo were removed; `react-dom` is build-only, the dashboard preview reuses the deterministic adapter’s normalized events, and CLI/dashboard/doctor share one reachability probe that prunes only unreachable sockets—not transient timeouts.
- The test suite was audited for tautologies and redundant implementation checks. None were removed: the small tests protect previously observed UI/control regressions.
- The built CLI boots under an exact Nix Node.js 22.23.1 runtime as well as the local Node 24 runtime.
- Source and built-package Pi launchers both completed bounded real nested runs.
- The original broad Pi audit produced exactly Scout, Verifier, and Nested after delegation hardening.
- A real Pi Luna/low root declared `DRAFT → VERIFY → DONE`, traversed a verifier-failure loop-back, and wrote every execution event to the trace.
- A real non-delegating Pi worker declared and completed its own two-node execution through the scoped coordinator; it could instrument without receiving spawn permission.
- Playwright enters/exits the nested demo Yard and verifies the exact semantic execution panel.
- Real Codex child stop/parent wake-up and clean native-TUI rendering have been validated.
- The Codex MCP server passes an official SDK client round-trip and an exact stdio subprocess launch. A direct Codex `exec` call completed `watchdog_execution list`; a remote TUI showed `watchdog` among its App Server MCP tools. The final remote model call was blocked by the account usage limit after tool startup, not by MCP initialization.
- Packed Node 22 installation, CLI, dashboard assets, Pi extension, and `doctor` were previously validated.

Repository:

- Public: `https://github.com/awesamarth/watchdog`
- Branch: `main`
- Latest pushed commit: `fbc2e52` (`tui fixes, codex bug fixes, more progress`)
- Most dashboard, distribution, multi-run, and Pi work after that commit is uncommitted.
- `.watchdog/`, `.devpost-hackathon-state.json`, generated output, and `docs/` are ignored. Keep `docs/` ignored.

## Next work

The graph foundation, Codex/Pi instrumentation, dynamic Yard, nested navigation, and exact Operator graph are implemented. Next:

1. Rehearse one stronger real workflow containing parallel fork, join, verifier failure, bounded retry, and a nested Pi subgraph; tune warnings from that evidence.
2. Complete one remote Codex TUI model-call smoke test after usage resets; server discovery/startup and direct Codex MCP calls are already validated.
3. Design external-event triggers as activations of existing graph/subgraph definitions; do not turn Watchdog into a workflow engine accidentally.
4. Decide retention/replay UX for completed graph runs and stopped nodes.
5. Manually validate simultaneous live Codex and Pi runs in the shared dashboard.

Later:

- manually validate simultaneous live Codex and Pi runs in the shared dashboard;
- improve automatic loop-boundary/verifier capture;
- add honest Codex dollar-cost provenance;
- finalize npm naming/license/install docs and publish only with permission;
- research Claude Code dynamic-workflow and OpenCode adapter surfaces;
- prepare Devpost submission assets when the live demo is stable.

## Open decisions

- Whether a public SDK should complement the working Codex/Pi `watchdog_execution` tools for non-harness orchestrators.
- Exact semantics and authorization for external-event-triggered subgraphs.
- Whether Watchdog ever executes graphs or remains an observer/controller with optional instrumentation.
- Whether the Yard’s `+N` large-graph projection needs an explicit expand/full-map interaction beyond Operator.
- Final retention/reuse UX for completed/stopped workers.
- Final npm package name, license, and availability.
- Exact Claude Code and OpenCode event/control surfaces.
