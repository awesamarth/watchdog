# Watchdog — Project Handoff

Read this first in a fresh session. Keep it current, compact, and forward-looking: replace stale facts instead of appending history.

## Working rules

- Run `git status --short` before editing. The dirty tree contains valuable uncommitted work.
- Preserve unrelated user changes. Never reset or discard the worktree.
- Use Bun for local development. Published output must run on ordinary Node.js 22 without Bun.
- Use `apply_patch` for edits.
- Do not commit, push, or publish without explicit permission. The user selected the MIT license and `@awesamarth/watchdog` package name on 2026-07-21.
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

Pi’s lead developer separately described the underlying object as a directed graph and suggested external events can trigger whole subgraphs. That is useful background, but the user explicitly dropped external triggers from Watchdog’s product scope: interactive harnesses own when work starts, and Watchdog intervenes after an execution exists.

Watchdog should model this without immediately becoming another workflow engine:

1. Observe and normalize graph definitions/runs from harnesses that expose them.
2. Add a small explicit instrumentation surface when a harness has no authoritative graph primitive.
3. Consider execution/SDK features only after the observation/control model is sound.

A useful split is:

- `GraphDefinition`: reusable nodes, directed edges, gates, subgraph references, and declared budgets.
- `GraphRun`: one activation with node attempts, statuses, inputs/outputs, iteration IDs, evidence, tokens/cost, timestamps, and controls.

Likely node kinds: agent, task, tool, verifier/gate, event, and subgraph. Likely edge kinds: dependency, control, data, conditional, and back-edge.

### Graph implementation status

Watchdog now has a first-class additive execution model:

- named graph definitions with entry/terminal nodes, directed typed edges, authority/source, and parent execution/node links;
- node attempts, concurrent active nodes, edge traversals, iteration events, completion state, and owner-thread correlation;
- execution-native verifier policy, evidence, verification result, token/iteration budgets, and used-token rollups;
- `loop-back` edges identify cycles without assuming every execution is a loop;
- `subgraph` nodes open nested executions;
- legacy `loop` commands update an existing explicit execution when possible, otherwise translate to the honest compatibility cycle `ATTEMPT → VERIFY → DONE`;
- derived warnings cover missing/stalled/failed verifiers, runaway cycles, budget burn, fan-out/concurrency, duplicate assignments, blocked joins, repeated failures, and requested/effective configuration mismatches;
- if a real owner turn ends while explicit instrumentation still claims a node/execution is running, snapshots mark it `incomplete` with provenance instead of fabricating completion; runtimes without owner-turn lifecycle events are not guessed about;
- capability-derived controls can stop a concrete node, nested subgraph, or whole execution only when every affected live agent is interruptible; a node retry requires exactly one retained retry-capable agent context;
- lower-authority inferred/legacy definitions cannot overwrite authoritative ones;
- malformed edges, duplicate IDs, invalid subgraph links, and invented nodes are rejected.

The model is additive: old event traces still replay and snapshots from older running Watchdog versions are normalized with `executions: []`. Explicit graph events remain in the append-only trace.

Pi exposes this through `watchdog_execution`, available to the root and to every scoped worker. CLI/scripts/adapters can use `watchdog execution declare/update/start/finish-node/edge/evidence/verify/stop/retry-node/finish`.

Codex now receives the same `watchdog_execution` surface through a run-scoped stdio MCP server configured on the Watchdog-owned App Server. The launcher generates the run ID before starting the App Server, injects ephemeral `-c mcp_servers.watchdog.*` settings there, and starts the control socket with the same ID. It does not modify global/project Codex config. Only the metadata tool is allow-listed and pre-approved; it cannot edit files or control agents. Configure it on the App Server, not the `codex --remote` frontend—the remote frontend's MCP config does not become a backend thread tool. Do not claim Codex automatically infers arbitrary graph boundaries.

The public `loop set/evidence/verify` commands remain as a compatibility surface for old scripts and opaque loops; they are no longer a separate conceptual policy layer. External triggers are deliberately out of scope.

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
- In-memory live state plus append-only `.watchdog/runs/*.jsonl`; `watchdog replay` streams historical traces back through the same normalized read-only surfaces, so no replay database is needed.
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
src/runtime/replay.ts        streaming read-only historical trace replay
src/server/dashboard.ts      dashboard catalog/control bridge
src/tui/                     Ink UI
web/src/App.tsx              dashboard, Operator, inspector
web/src/YardCanvas.tsx       pixel Yard
web/public/assets/           tuned raster assets
```

## Implemented surfaces

- `watchdog codex` owns a loopback Codex App Server and launches the normal Codex TUI with `codex --remote`.
- `watchdog observe` identifies the latest ordinary Codex session for the cwd, hydrates a bounded recent JSONL tail, then follows new records every 500 ms as a read-only fallback. It ignores inherited `session_meta` records inside resumed files and understands both custom-tool and function-call record forms.
- `watchdog pi` launches normal Pi with the bundled Watchdog extension as an optional one-run convenience. It does not install or persist the extension.
- CLI: `runs`, `traces`, `replay`, `ps`, `tree`, `inspect`, agent controls, legacy loop controls, execution instrumentation/control, `tui`, `dashboard`, and a harness-aware `doctor`. The dashboard surfaces only real owned, observed, or replayed runs; product demonstrations use real Codex/Pi sessions.
- Ink TUI: pane-aware agent selection, independently scrollable inspector, capability-derived agent/node/execution control hints, and execution policy/evidence/budget summaries.
- Running `watchdog` without a command prints a blue block-letter wordmark, the concise product pitch, and then the complete command reference; preserve `NO_COLOR` and non-TTY plain-text output.
- Browser: live/replayed Yard, semantic/nested execution stations with breadcrumbs, exact graph edges in Operator, resizable inspector, session picker, execution controls/policy/proof, adapter identity, empty live Yard, day/night mode, and `/reveal`.
- State includes recursive agents, messages/activity/config, total/input/output tokens, cost, plus first-class execution graphs, activations, traversals, verifier policy, evidence, verification, budgets, warnings, and capability-aware agent/node/execution controls.
- Multi-run selection uses the only run in the cwd or explicit `--run <id-prefix>` when ambiguous.
- The public README is user-first: product motivation and the Devpost-required “How Codex and GPT-5.6 were used” evidence appear near the top; npm installation and Codex/Pi operation follow; a complete grouped public CLI table, capability boundaries, local-first behavior, graph semantics, and replay are documented; source development and contribution instructions are isolated at the end.

## Capability truths

Controls must always be adapter- and state-aware. Never display or claim a capability the live adapter cannot perform.

- No current adapter exposes a truthful resumable pause primitive, so Watchdog does not show one.
- Whole-execution/node/subgraph stop first capability-checks every affected live agent; no instrumentation-only state change may masquerade as an interrupt.
- Node retry is a retained-context rerun of one concrete node attempt, not a magical workflow restart. Whole-graph rerun remains unsupported.
- Observed JSONL and historical replay runs are fully read-only.

### Codex

- A Watchdog-owned App Server provides live root/child events, output, activity, token updates, and topology. `parentThreadId` from `thread/read` is the topology source of truth.
- App Server `subAgentActivity` items are the authoritative live mapping between a child thread ID and Codex's canonical agent path (for example `/root/runtime`). The enclosing notification is the parent thread. Preserve this mapping so graph instrumentation and stop notifications can resolve the same child identity the root sees.
- Root steer, interrupt, and retry work when current turn IDs are valid.
- Native multi-agent-v2 children accept direct interrupt but reject direct steer/start. They are stop-only today.
- In a real 2026-07-19 `multi_agent_v1` rehearsal, the root could spawn children but a spawned child received Watchdog MCP instrumentation with no nested-agent spawn tool. Do not ask a Codex child to create a grandchild unless its live tool surface actually exposes delegation. Nested execution graphs can still be real while the root orchestrates their steps; Pi supports true nested worker delegation.
- Stopping a first-level child can wake/notify the root automatically. Nested-child notification must distinguish direct-parent notification from root-only notification.
- Codex root turns may track children by canonical task paths while App Server metadata assigns separate nicknames. Stop notifications include every available identity plus the stable thread ID; nickname-only notifications can make the root believe the wrong child was stopped.
- Requested child model/effort and effective child model/effort are separate. Natural-language model requests are not reliable; real runs have exposed mismatches.
- Codex may expose a spawned child’s requested prompt as an opaque `gAAAAA…` transport payload. Runtime state rejects those values; the hydrated child turn input is the authoritative assignment, and the UI must show a truthful unavailable fallback if that input never arrives.
- App Server `commandExecution.command` and dynamic-tool arguments contain richer activity than the tool name alone. Show the actual command when available and retain a bounded recent activity history; do not reduce command work to a generic `exec`.
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

Pi distribution must remain independent of the launcher:

- The package manifest exposes `./dist/pi-extension.js` through `pi.extensions`, so an installed Watchdog package auto-loads inside ordinary `pi`.
- `@awesamarth/watchdog@0.1.1` is the current public npm release under the MIT license.
- From a source checkout, build first and run `pi install .` (or `pi install . -l` for project-local installation); future ordinary `pi` sessions should then load Watchdog without `watchdog pi`.
- The published Pi flow is `pi install npm:@awesamarth/watchdog` followed by plain `pi`.
- Never turn `watchdog pi` into a hidden/bundled installer or make running it once a setup prerequisite. Keep it as an explicit convenience launcher that guarantees the extension for that invocation.

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
- The default Yard is anchored to the real topology root. A worker-owned execution never replaces the root or hides sibling cars automatically; it opens only through an explicit inspector action and receives a UI-only ancestry breadcrumb back to the main Yard.
- Operator shows exact named nodes/edges separately from the recursive subagent topology. Do not call an agent tree the execution graph.
- Operator node cards and ordinary Yard stations open a node-first inspector with attempt history, assigned-agent links, time-bounded correlated messages/tools, edges and traversal counts, evidence, and capability-derived stop/retry. Agent activity is clearly labeled as correlation, not falsely claimed as exact node output.
- Loop-back edges use a return arrow and traversal count in Operator. A structural loop and its number of observed traversals are separate facts.
- The fixed pixel world is 1100×680 with contain scaling and centered letterboxing. Hit-testing must invert the same transform.
- The full-body German shepherd stays visible and pettable. Petting has a fixed baseline, small white hearts, no tooltip, and no sound.
- Train count is dynamic. The right-facing root uses a mirrored sprite with compensated selection brackets and nameplate; keep both on the same X offset.
- Children alternate above/below the main line on perpendicular spurs; working children stay at their outer positions, while completed children dock near the visible main-rail edge with 10px clearance calculated from the scaled sprite/nameplate bounds and remain inspectable.
- A generated pixel-art carriage Dock occupies the Yard’s bottom-left only after a displayed root has more than nine direct subagents. The oldest completed cars move there first until nine regular cars remain; live, failed, stopped, blocked, or interrupted work is never hidden to satisfy the cap. Clicking the Dock opens its full inspectable roster; Operator retains the complete topology.
- Stopped children remain retained and inspectable on their spur with a distinct red stopped treatment; do not present interruption as ordinary completion.
- Smoke is a separate animation. Preserve user-tuned chimney/smoke anchors.
- The empty `/` route retains the Yard and confused dog but no trains. `/reveal` remains the only additional document route and is runtime-independent.
- When a run appears after the dashboard opened empty, the automatic offline notice must transition to the live harness label without requiring a page refresh; operator-action notices remain sticky.
- Clicking a child opens child-first details: assignment, activity, live response/history, tokens/config, then parent-loop context. Long content must wrap.
- The desktop inspector splitter persists width under `watchdog.inspector-width`; Left/Right/Home/End adjust it and double-click resets it. At 980px and below, the inspector stacks without overwriting desktop preference.
- The shared Yard/Operator inspector uses deliberately readable body, task, history, configuration, and execution typography. Keep overflow vertically scrollable instead of shrinking the sidebar text to fit.
- Requested configuration says `no override` / `default effort`, not `not exposed`.
- The shared Yard/Operator header keeps aggregate `TOKENS` and shows separate cumulative `IN` and `OUT`; older traces with no input split render `—` instead of inventing it.
- Completed-message history retains the newest 100 per agent in memory; full completed history remains in JSONL. Streaming deltas are not logged individually.
- Recent activity retains the newest 50 tool calls per agent, coalescing started/completed lifecycle events by item ID. The inspector interleaves responses and commands in one newest-first transcript: a completed turn’s final response stays topmost, while the newest tool event is labeled `CURRENT ACTION` only while running and `LAST ACTION` after completion. Complete lifecycle events remain in JSONL.
- Agent responses in the browser transcript render GitHub-flavored Markdown through `react-markdown` + `remark-gfm`; tool commands/actions remain literal monospace text. Raw HTML is not enabled.
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
- 67 unit tests across 18 files pass.
- 2 Playwright browser tests pass, including a ten-child Dock overflow/click-through check.
- Production build and package dry-run pass; the next package build is 2.44 MB unpacked across 33 files. The 11 runtime PNGs were palette-compressed without changing filenames, dimensions, or alpha behavior; visually compared originals remain backed up at `~/Desktop/watchdog-assets/`. Devpost-only thumbnail assets live under `assets/submission/` and are deliberately excluded from the runtime package. GitHub-flavored Markdown rendering and trace replay account for most remaining non-image weight.
- The remaining package weight is intentional and dominated by visually verified raster art. Do not resize/re-encode it without visual comparison.
- Release source maps and one unreferenced 1,254px logo were removed; `react-dom` is build-only, and CLI/dashboard/doctor share one reachability probe that prunes only unreachable sockets—not transient timeouts. `doctor` treats Codex and Pi as alternative harnesses and requires at least one, rather than incorrectly failing Pi-only installations.
- The test suite was audited for tautologies and redundant implementation checks. None were removed: the small tests protect previously observed UI/control regressions.
- The built CLI boots under an exact Nix Node.js 22.23.1 runtime as well as the local Node 24 runtime.
- Source and built-package Pi launchers both completed bounded real nested runs.
- The original broad Pi audit produced exactly Scout, Verifier, and Nested after delegation hardening.
- A real Pi Luna/low root declared `DRAFT → VERIFY → DONE`, traversed a verifier-failure loop-back, and wrote every execution event to the trace.
- A real non-delegating Pi worker declared and completed its own two-node execution through the scoped coordinator; it could instrument without receiving spawn permission.
- A worker-owned execution no longer replaces the topology-root Yard or hides sibling agents; it opens explicitly from that worker’s inspector and has an ancestry breadcrumb back to the main Yard.
- Real Codex child stop/parent wake-up and clean native-TUI rendering have been validated.
- Real `watchdog observe --once` hydration against the current 406 MB resumed Codex session completes in about 0.22 seconds and reconstructs its active turn, task, model/effort, latest message/activity, and tokens; a live observer then followed appended tool/token events.
- The Codex MCP server passes an official SDK client round-trip and an exact stdio subprocess launch. A direct Codex `exec` call completed `watchdog_execution list`; a remote TUI showed `watchdog` among its App Server MCP tools. The final remote model call was blocked by the account usage limit after tool startup, not by MCP initialization.
- Packed Node 22 installation, CLI, dashboard assets, Pi extension, and `doctor` were previously validated.

Repository:

- Public: `https://github.com/awesamarth/watchdog`
- Branch: `main`
- The pre-demo release includes the dashboard, distribution, multi-run, Pi, graph-control, replay, and package-size work described above.
- `.watchdog/`, `.devpost-hackathon-state.json`, generated output, and `docs/` are ignored. Keep `docs/` ignored.

## Next work

Graph controls, loop-policy unification, orchestration warnings, stopped retention, and streaming trace replay are implemented. Next:

1. Manually exercise the new stop/retry controls and warnings in one real workflow containing a parallel fork, join, verifier failure, bounded retry, and nested Pi subgraph.
2. Complete one remote Codex TUI model-call smoke test after usage resets; server discovery/startup and direct Codex MCP calls are already validated.
3. Manually validate simultaneous live Codex and Pi runs in the shared dashboard.
4. Prepare a tagged GitHub release after the pushed source and npm artifact are confirmed aligned.
5. Prepare the Devpost video and assets from real Codex/Pi runs after the live story is stable.

Later:

- improve automatic loop-boundary/verifier capture;
- add honest Codex dollar-cost provenance;
- research Claude Code dynamic-workflow and OpenCode adapter surfaces;

## Open decisions

- Whether a public SDK should complement the working Codex/Pi `watchdog_execution` tools for non-harness orchestrators.
- Whether Watchdog ever executes graphs or remains an observer/controller with optional instrumentation.
- Whether the Yard’s `+N` large-graph projection needs an explicit expand/full-map interaction beyond Operator.
- Release cadence and whether later adapter wrappers warrant separate packages.
- Exact Claude Code and OpenCode event/control surfaces.
