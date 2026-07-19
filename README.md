# Watchdog

Local operator control plane for subagents, agentic loops, and execution graphs

## What it does

`watchdog codex` starts a private local Codex App Server, launches the ordinary Codex terminal UI through its `--remote` option, and attaches a second local Watchdog client to the same runtime.

It is not a container and it does not replace Codex. Your normal Codex auth, config, working directory, terminal I/O, and tools remain in use.

`watchdog pi` launches the ordinary Pi TUI with Watchdog's extension loaded. The same extension can also be loaded directly into an existing Pi workflow. Because Pi does not currently provide native subagents, Watchdog adds persistent Pi RPC workers with stable identities, permissioned nested delegation, live messages/tool activity, per-worker model/thinking/tool/cwd configuration, token and dollar-cost rollups, and real steer/follow-up/stop/retry controls. Pi remains the harness; Watchdog supplies the missing worker and control layer.

Watchdog keeps live normalized state in memory, gives every launch a unique run ID and private local control socket, and saves an append-only JSONL trace under `.watchdog/runs/`. Active runs register under `~/.watchdog/registry/`, so Codex and Pi sessions—even in the same project—remain independently addressable. It tracks recursive topology, activity and turn transitions, live and completed messages, requested versus effective model/reasoning configuration, tokens/cost, explicit execution nodes/edges/activations, loop objective/iteration/verifier/evidence/budgets, and capability-aware controls.

## How Codex and GPT-5.6 were used

Watchdog was designed, built, debugged, and validated in the Codex CLI with GPT-5.6. Codex was the only AI coding agent used during development—and, because Watchdog integrates with Codex, it served as both the development collaborator and the live system under test.

- **Product and architecture:** Codex helped turn the initial subagent-observability idea into a local-first control plane spanning subagents, agent loops, and execution graphs, then pressure-tested the scope and capability boundaries.
- **Implementation:** GPT-5.6 worked across the TypeScript runtime, Codex App Server adapter, normalized event model, control sockets, CLI, Ink TUI, React/Vite dashboard, tests, and documentation.
- **Codex integration research:** Codex inspected and exercised its own public runtime surfaces to map thread topology, streamed activity, requested-versus-effective model and reasoning configuration, token usage, and the controls actually available for roots and native children.
- **Live validation:** Development sessions spawned real native Codex subagents, inspected their activity through Watchdog, interrupted them from a separate control surface, and verified automatic parent notification. Those rehearsals exposed timeout and nested-parent reporting gaps that were fixed and covered by tests.
- **Continuous dogfooding:** Watchdog is developed through `watchdog codex`, so new observability and intervention features are tested against the same workflow they are intended to improve.

## Quick start from source

```bash
bun install
bun run dev -- codex
```

Or launch Pi through the same control plane:

```bash
bun run dev -- pi
```

Both launchers forward normal harness arguments:

```bash
bun run dev -- codex --model gpt-5.6-terra
bun run dev -- pi --model openai-codex/gpt-5.6-luna --thinking low
```

For a temporary direct Pi integration without the launcher:

```bash
pi --extension ./src/pi/extension.ts
```

The npm package is not published yet. Its manifest and production build already expose `dist/pi-extension.js` as a Pi extension, but do not install or publish the current package as if it were a released artifact.

Start the browser dashboard in a second terminal:

```bash
bun run dashboard
```

The command opens `http://127.0.0.1:4242` automatically. If a Watchdog dashboard already owns that port, it reuses and opens the existing instance; it never mistakes an unrelated local service for Watchdog. The browser receives pushed state over a local WebSocket and can switch among every active live run from its session picker. The selected harness is explicit in both Yard and Operator (`WATCHING CODEX` or `WATCHING PI`). The root page never mixes in simulations; without a live run, it reports that there are no running sessions and links to the read-only demo at `http://127.0.0.1:4242/demo`.

For a deterministic, interactive rehearsal with warnings and working controls:

```bash
bun run demo
```

This starts and opens an explicitly labeled simulation at `/demo` with working rehearsal controls; it never appears as a live session on `/` or pretends that mock activity came from Codex. The corresponding real-harness intervention checks are documented under Verification below.

The dashboard has two modes:

- **Yard:** an animated pixel-art rail yard where an ordinary task runs from `START` to `END`, while an instrumented workflow uses its real semantic node names as stations. Cycles are loops; subgraph stations open a nested Yard with breadcrumbs. The root is a right-facing locomotive, and every subagent gets a labeled branch car on a perpendicular spur. Children alternate above/below the main line, remain parked away while working, and move toward it when complete; crowded sidings scale the cars down without imposing a fixed agent limit. Click the full-body German shepherd to pet him; click a train to inspect that exact agent's assignment, current activity, live response, timestamped message history, execution node, model/effort, and tokens.
- **Operator:** the same state as exact semantic nodes/edges plus the recursive subagent topology, activity table, configuration comparison, token/cost rollup, and capability-aware controls.

Use the sun/moon button to inspect the day and night palettes. Controls follow the selected adapter rather than a hard-coded UI: active Codex native children are stop-only, while Watchdog Pi workers can be steered, followed up, stopped, and retried with model/thinking overrides.

Forward a normal Codex prompt or options after `codex`:

```bash
bun run dev -- codex "Spawn exactly two subagents: one to map the project, one to identify risks. Do not edit files; return their findings."
```

The terminal remains Codex. Once its UI starts, Watchdog does not render live status, socket, or event-log output into that terminal, so nothing competes with Codex's full-screen renderer. Use the dashboard, TUI, or second-terminal commands to inspect the run. Normalized events still go to the saved JSONL trace and control surfaces; App Server diagnostics go to the adjacent `.diagnostics.log`. Press `Ctrl+C` to stop the session; Watchdog forwards the signal and stops its local runtime.

The Watchdog-owned Codex App Server also receives a run-scoped local MCP tool named `watchdog_execution`. It lets Codex declare and update real workflow nodes, edges, iterations, and nested subgraphs without shelling out or modifying `~/.codex/config.toml`. Only that metadata tool is enabled and pre-approved; it cannot edit files or control agents. Its instructions explicitly keep ordinary one-shot turns out of the execution-graph model and require honest opaque nodes when Codex does not know the internal stages.

### Pi commands and subagents

When the extension is active, Pi's native footer shows:

```text
watchdog: active · 2/3 subagents
```

The extension adds:

```text
/watchdog-start    start or restart the local Watchdog runtime
/watchdog-stop     stop Watchdog and its Pi workers, not Pi
/watchdog-status   show run and worker counts
/watchdog-agents   list workers and current activity
/watchdog-open     start/open the browser dashboard
```

The model receives a `subagent` tool for spawning and controlling persistent workers. If another extension already owns that name, Watchdog deliberately avoids overriding it and registers `watchdog_subagent` instead. It also receives `watchdog_execution`, an instrumentation tool for declaring real workflow nodes and edges, marking node attempts and transitions, and nesting a child execution under a subgraph node. Its guidance explicitly keeps ordinary turns out of the graph model and forbids guessing hidden phases.

Nested delegation is default-deny. Every spawned worker gets a scoped opaque credential so it can instrument its own nested execution; that credential does not grant permission to spawn or control subagents. The `subagent` tool is exposed to a worker only when its task explicitly sets `allowDelegation: true`; its lifetime `maxChildren` and descendant `maxDepth` budgets both default to 1. Non-delegating workers cannot spawn children, and a delegating worker can list or control only its own subtree. The coordinator derives worker identity from that credential instead of trusting a caller-supplied parent ID. Global worker, concurrency, and depth limits default to 12, 4, and 3 and remain the final safety net; they can be overridden with `WATCHDOG_PI_MAX_WORKERS`, `WATCHDOG_PI_MAX_CONCURRENT`, and `WATCHDOG_PI_MAX_DEPTH`.

Pi worker operations include parallel spawn, list, steer, follow-up, stop, and retry. An active-worker follow-up joins Pi's native follow-up queue; an idle-worker follow-up starts a context-preserving new turn instead of leaving a dormant queue. A retry reuses the stable worker identity, starts a fresh Pi session, and can change the effective model and thinking level. The interactive Pi root supports observation, steer, follow-up, and stop; Watchdog does not advertise root retry because Pi's extension API does not expose a truthful retry primitive for it.

Check demo-day prerequisites without changing anything:

```bash
bun run dev -- doctor
```

In a second terminal in the same project, inspect the live run without leaving the CLI:

```bash
bun run dev -- runs
bun run dev -- ps
bun run dev -- tree
bun run dev -- inspect <agent-name>
bun run dev -- tui
```

When exactly one run is active in the current project, the other commands select it automatically. If several runs match, select one explicitly with `--run <id-or-unique-prefix>`:

```bash
bun run dev -- tree --run codex-mh2
bun run dev -- stop Cicero --run codex-mh2
bun run dev -- follow-up Reuser "Now verify the edge case" --run pi-mh2
bun run dev -- tui --run codex-mh2
```

`watchdog tui` is a small keyboard-first control surface with pane-aware navigation. The Run Tree is focused first, where arrows or `j/k` select an agent. `Tab` or `→` focuses the Inspector, where those keys scroll one line and Page Up/Down scroll half a viewport; `Tab`, `←`, or Escape returns to the tree. Home/End jump within the focused pane and `q` quits. The footer lists only controls the selected agent actually supports, with explicit labels such as `s steer`, `f follow-up`, `x stop`, and `r retry`. Native Codex v2 subagents therefore show only `x stop` while active; Pi RPC workers expose the controls their persistent process can actually perform.

Declare loop intent and proof explicitly from either the CLI or dashboard:

```bash
bun run dev -- loop set root --verifier "all tests pass three times" --token-budget 120000 --max-iterations 5
bun run dev -- loop evidence root "Regression suite passed on the candidate fix"
bun run dev -- loop verify root pass "Exit criterion satisfied"
```

The legacy `loop` commands remain compatible because they still carry loop-policy information that graph traversal alone does not: verifier state, evidence, token budget, and iteration budget. They render an honest `ATTEMPT → VERIFY → DONE` cycle; Watchdog does not pretend to know the hidden body of the attempt. Rich workflows use the execution model instead. Codex and Pi can instrument that model directly with `watchdog_execution`; scripts and adapters can use the same control plane:

```bash
bun run dev -- execution declare ./workflow.json
bun run dev -- execution start release-checks audit --agent root --activation audit-1 --iteration 1
bun run dev -- execution finish-node release-checks audit audit-1 pass "Audit complete"
bun run dev -- execution edge release-checks audit-to-test --iteration 1
```

`workflow.json` contains a stable execution id, `ownerThreadId` (usually `root`), named nodes, directed edges, entry nodes, and terminal nodes. An edge marked `loop-back` is a loop. A node with `kind: "subgraph"` and `subgraphId` links to another declared execution; the child execution carries the matching `parentExecutionId` and `parentNodeId`. Old traces without `executions` still load as ordinary tasks or legacy loops rather than being assigned invented stations.

Watchdog can also follow an ordinary Codex CLI session through its persisted JSONL when it did not launch that session:

```bash
bun run dev -- observe
# or reconstruct once and exit
bun run dev -- observe --once
```

This fallback is near-live and deliberately read-only. It reconstructs session/child topology, activity, model/effort context, token use, objectives, and evidence from fields Codex persists, but it cannot reliably steer or stop that external process. Relaunch through `watchdog codex` for full controls.

To prove the first subagent path after a run, inspect the latest trace:

```bash
latest=$(ls -t .watchdog/runs/*.jsonl | head -1)
rg 'agent.spawned|tokens.updated' "$latest"
```

You should see one `agent.spawned` edge per child, including Codex-assigned names when available, plus per-thread token updates.

## Verification

```bash
bun run check
bun run test
bun run test:web
bun run build
```

The unit suite covers normalized execution graphs and cycles, legacy loop compatibility, nested topology, adapter capability gates, Pi JSONL RPC, persistent worker controls and scoped instrumentation, JSONL reconstruction, multi-run registration/control routing, and semantic train motion. The browser test launches two simultaneous runtimes, switches between them, enters and exits a nested Yard, and verifies assets, demo-mode loading, mascot interaction, recursive Operator topology, Yard/Operator switching, and day/night rendering with a real Chromium browser.

**Live intervention validation (CLI 0.144.4, 2026-07-15):** a real remote Codex TUI spawned a sleeping native child (`Cicero`). `watchdog stop Cicero` interrupted it, automatically steered the active root, returned `parentNotified: true`, and the root acknowledged the stop and exited its wait without requiring the operator to type a follow-up. Remote mode is interactive-only in this CLI; `codex exec --remote` is not supported.

Control requests are bounded: local Watchdog socket actions time out instead of hanging forever, Codex RPC requests have their own deadline, and an unexpected App Server disconnect rejects pending work immediately. For a nested `root → child → grandchild` stop, Watchdog notifies the steerable root but reports `parentNotified: false` because Codex does not permit direct input to the immediate native-child parent.

**Live Pi validation (Pi 0.80.10, 2026-07-19):** a Watchdog-owned Pi root spawned a persistent RPC worker, captured its streamed/final response, effective model/thinking level, tokens, and provider-reported dollar cost, then received its result. A nested `root → Parent → Nested` run completed without deadlocking: Parent entered `waiting`, yielded its concurrency slot, and resumed after Nested finished. `watchdog stop Sleeper` aborted a real worker and unblocked the root automatically. A worker retry changed Luna from `low` to `minimal`, preserved the stable worker identity, and produced a second verified response; the trace recorded both requested and effective configurations.

## Cross-harness adapter boundary

`HarnessAdapter` is the seam for Codex, Pi, and future Claude Code support. Each adapter identifies its harness, transport, and mode; emits the same normalized `WatchdogEvent` values; and publishes per-agent capabilities for observe, steer, follow-up, interrupt, retry, and model override. Loop policy, the TUI, and the dashboard consume that contract instead of harness protocol details.

Current adapters:

- Codex App Server: live native root/child events and capability-aware controls for Watchdog-owned runs.
- Codex JSONL: near-live observation with every mutation capability explicitly unavailable.
- Pi extension + RPC: native root extension events plus persistent controllable subprocess workers, including nested topology.
- Deterministic simulation: demo/rehearsal only and always labeled as such.
