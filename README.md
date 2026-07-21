# Watchdog

**Control subagents, agentic loops, and execution graphs from one local command center.**

[![npm](https://img.shields.io/npm/v/%40awesamarth%2Fwatchdog?color=f2bf4f)](https://www.npmjs.com/package/@awesamarth/watchdog)
[![license](https://img.shields.io/npm/l/%40awesamarth%2Fwatchdog)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-77c86f)](https://nodejs.org/)

Watchdog gives you one live view of what your coding agents are doing, what they cost, how they relate to each other, and which controls the active harness can actually perform.

It works with the real Codex and Pi terminal interfaces. It does not replace either harness, put your agents in containers, or send their state to a hosted service.

## Why Watchdog

Subagents make parallel work possible, but they also make it easy to lose track of:

- who spawned whom;
- what each agent is currently reading, running, or saying;
- which model and reasoning effort it actually received;
- how many tokens and dollars the run is consuming;
- whether work is duplicated, stalled, blocked, or looping;
- and whether an agent, node, or execution can be safely stopped or retried.

Watchdog normalizes those details across harnesses and exposes them through three local surfaces:

- **Yard:** a live pixel-art overview of roots, subagents, loops, and graph stages.
- **Operator:** exact topology, messages, tool activity, configuration, usage, warnings, graph edges, and controls.
- **TUI:** a keyboard-first inspector and control surface for staying entirely in the terminal.

## How Codex and GPT-5.6 were used

Watchdog was designed, implemented, debugged, and validated through the Codex CLI with GPT-5.6, primarily GPT-5.6 Sol at extra-high reasoning effort. All product-development assistance came from Codex and GPT-5.6. Pi was used as a target harness for cross-harness integration rehearsals, not as a separate implementation assistant.

- **Product shaping:** Codex helped turn an initial subagent-observability idea into a capability-aware control plane spanning subagents, loops, and execution graphs. It also challenged the boundary between Watchdog and existing harnesses so the project did not become another agent harness.
- **Architecture:** GPT-5.6 designed the normalized event and capability contracts, per-run socket/registry model, Codex App Server integration, Pi extension and RPC-worker model, trace replay, and shared browser/TUI state.
- **Implementation:** Codex worked across the TypeScript CLI/runtime, MCP integration, Pi extension, Ink TUI, React/Vite dashboard, pixel Yard, tests, package configuration, and user documentation.
- **Integration research:** Codex inspected and exercised real Codex runtime surfaces to distinguish public capabilities from inferred behavior, including child topology, streamed activity, requested-versus-effective model configuration, token usage, and root/child control boundaries.
- **Live validation:** Real Codex sessions spawned native children that Watchdog observed and interrupted. Real Pi sessions spawned persistent and nested workers, exercised steering, stopping, retry, model/thinking overrides, scoped delegation, and execution instrumentation.
- **Bug discovery through dogfooding:** Watchdog was repeatedly developed through `watchdog codex`. Those runs exposed renderer corruption from terminal logging, unbounded control waits, incorrect nested-parent notification claims, opaque child assignments, requested/effective model mismatches, runaway Pi delegation, and worker-owned graphs hiding sibling agents. Each finding changed the implementation and received focused regression coverage.

Codex therefore served both as the development collaborator and as one of the live systems under test. The resulting architecture, focused regression tests, and commit history preserve evidence of that process.

## Supported harnesses

| Harness | Integration | What Watchdog can do |
| --- | --- | --- |
| **Codex CLI** | Watchdog-owned Codex App Server plus a run-scoped MCP metadata tool | Observe roots and native children, stream messages and commands, compare requested/effective configuration, track tokens, instrument graphs, and use the controls Codex exposes |
| **Pi** | Native Pi extension plus persistent Pi RPC workers | Add first-class subagents, nested delegation, messages/tools, tokens and provider cost, graph instrumentation, steer, follow-up, stop, retry, and model/thinking overrides |
| **Ordinary Codex session** | Read-only persisted JSONL observer | Reconstruct near-live topology, tasks, activity, messages, configuration, and token usage without owning the process |
| **Historical trace** | Streaming replay | Reopen completed runs in the same dashboard and TUI with every mutation control disabled |

Watchdog is capability-aware. A button appears only when the selected harness and agent can truthfully perform that action.

## Requirements

- Node.js 22 or newer
- Codex CLI and/or Pi already installed and authenticated
- macOS or Linux for the local Unix-socket control plane

## Install for Codex

Install the package globally:

```bash
npm install -g @awesamarth/watchdog
```

From your real project directory, launch the normal Codex terminal UI through Watchdog:

```bash
watchdog codex
```

Watchdog preserves your Codex authentication, configuration, working directory, tools, permissions, and terminal experience. It does not modify `~/.codex/config.toml`.

Normal Codex arguments and prompts pass through unchanged:

```bash
watchdog codex --model gpt-5.6-terra
watchdog codex "Use two subagents to inspect this repository and report their findings."
```

Open the browser dashboard from a second terminal:

```bash
watchdog dashboard
```

Or stay in the terminal:

```bash
watchdog tui
```

## Install for Pi

Install the same npm package as a Pi extension:

```bash
pi install npm:@awesamarth/watchdog
pi
```

Ordinary future Pi sessions will load Watchdog automatically. The native footer reports the active worker count:

```text
watchdog: active · 2/3 subagents
```

The extension adds these commands:

```text
/watchdog-start    start or restart the local Watchdog runtime
/watchdog-stop     stop Watchdog and its workers, not Pi
/watchdog-status   show the run and worker counts
/watchdog-agents   list workers and their current activity
/watchdog-open     start or open the browser dashboard
```

It also gives Pi a `subagent` tool for persistent workers and a `watchdog_execution` tool for loops and execution graphs. If another extension already owns `subagent`, Watchdog leaves it untouched and registers `watchdog_subagent` instead.

Pi users who also want the standalone `watchdog` CLI and TUI can install the package globally with npm. `watchdog pi` is an optional one-run convenience launcher; it never acts as a hidden installer.

### Pi delegation safety

Nested delegation is default-deny. A worker receives the subagent tool only when its spawn request explicitly enables delegation. Child and depth budgets default to one, workers can control only their own subtree, and scoped instrumentation credentials never grant delegation rights.

Global safety limits default to 12 workers, four concurrent model runs, and depth three. They can be adjusted when necessary:

```bash
WATCHDOG_PI_MAX_WORKERS=8 WATCHDOG_PI_MAX_CONCURRENT=3 pi
```

## Using the dashboard

`watchdog dashboard` opens `http://127.0.0.1:4242` and reuses an existing Watchdog dashboard when one already owns that port.

### Yard

An ordinary task renders honestly as `START → END`. Every direct subagent gets a labeled carriage on a perpendicular siding. Working cars remain out on their branches; completed cars return toward the main rail and older completed agents move into the Dock when the Yard becomes crowded.

Click a train to inspect its assignment, transcript, commands, model and reasoning configuration, tokens, cost, and available controls. Click the German shepherd to pet him.

### Operator

Operator separates two structures that agent interfaces often blur together:

- the **subagent topology**, which records who spawned whom;
- the **execution graph**, which records stages, dependencies, branches, joins, subgraphs, verifiers, and loop-back edges.

Node cards expose attempt history, correlated agent activity, traversed edges, evidence, budgets, warnings, and capability-derived controls.

### Multiple sessions

Codex and Pi runs remain independent even when they use the same project directory. Switch between them from the dashboard session picker or target a run explicitly:

```bash
watchdog runs
watchdog tree --run <run-id-prefix>
watchdog tui --run <run-id-prefix>
```

## Using the terminal controls

Inspect a live run:

```bash
watchdog ps
watchdog tree
watchdog inspect <agent-name>
watchdog tui
```

Control an agent when its adapter supports the action:

```bash
watchdog steer <agent-name> "Focus on the failing verifier."
watchdog follow-up <agent-name> "Now check the edge case."
watchdog stop <agent-name>
watchdog retry <agent-name> --model <model> --effort low "Retry with the retained evidence."
```

Current capability boundaries:

| Target | Observe | Steer | Follow-up | Stop | Retry/model override |
| --- | :---: | :---: | :---: | :---: | :---: |
| Codex root | Yes | Yes | No | Yes | Yes |
| Native Codex child | Yes | No | No | Yes | No |
| Pi root | Yes | Yes | Yes | Yes | No |
| Pi worker | Yes | Yes | Yes | Yes | Yes |
| Observed/replayed run | Yes | No | No | No | No |

These are runtime capabilities, not promises Watchdog fakes around. For example, stopping a whole execution is offered only when every affected live agent is actually interruptible.

## CLI reference

### Launch, inspect, and navigate

| Command | Purpose |
| --- | --- |
| `watchdog codex [args]` | Launch the normal Codex TUI with live Watchdog integration |
| `watchdog pi [args]` | Launch Pi with Watchdog loaded for this invocation |
| `watchdog dashboard [--port <port>]` | Start or reuse the local browser dashboard and open it |
| `watchdog tui [--run <id>]` | Open the terminal inspector and control surface |
| `watchdog doctor` | Diagnose Node, Codex/Pi availability, dashboard assets, and the current project runtime |
| `watchdog runs` | List reachable live and replay runs for the current project |
| `watchdog ps [--run <id>]` | Show a compact agent/process list |
| `watchdog tree [--run <id>]` | Print the recursive subagent topology |
| `watchdog inspect <agent> [--run <id>]` | Print the normalized state for one agent |
| `watchdog observe [--once] [--session <id>]` | Follow or reconstruct an ordinary Codex JSONL session read-only |
| `watchdog traces [--all]` | List saved Watchdog traces |
| `watchdog replay [latest\|trace.jsonl]` | Stream a saved trace back into the read-only dashboard/TUI model |

### Agent controls

| Command | Purpose |
| --- | --- |
| `watchdog steer <agent> <message> [--run <id>]` | Add guidance to an active steerable turn |
| `watchdog follow-up <agent> <message> [--run <id>]` | Queue or start a context-preserving follow-up |
| `watchdog stop <agent> [--run <id>]` | Interrupt an agent when its harness permits it |
| `watchdog retry <agent> [--model <model>] [--effort <effort>] <message>` | Retry from retained context with optional supported overrides |

### Loops and execution graphs

| Command | Purpose |
| --- | --- |
| `watchdog loop set <agent> [options]` | Attach compatibility-loop policy to an agent or existing execution |
| `watchdog loop evidence <agent> <summary>` | Record evidence for the current iteration |
| `watchdog loop verify <agent> <pass\|fail> [summary]` | Record the verifier result |
| `watchdog execution declare <graph.json>` | Declare a named graph definition and run |
| `watchdog execution update <execution> <patch.json>` | Update execution policy or metadata |
| `watchdog execution start <execution> <node> [options]` | Start a concrete node attempt |
| `watchdog execution finish-node <execution> <node> <activation> <pass\|fail\|stop>` | Finish one node attempt honestly |
| `watchdog execution edge <execution> <edge> [options]` | Record a selected edge traversal |
| `watchdog execution evidence <execution> <summary> [options]` | Attach evidence to an execution or node |
| `watchdog execution verify <execution> <pass\|fail> [summary]` | Record execution verification |
| `watchdog execution stop <execution> [--node <node>] [reason]` | Stop a controllable node, subgraph, or execution |
| `watchdog execution retry-node <execution> <node> [options] <message>` | Retry one retained, retry-capable node context |
| `watchdog execution finish <execution> <complete\|fail\|stop\|block>` | Finish the execution with an explicit outcome |

Run `watchdog --help` for every option. Commands that target a registered run accept `--run <id-or-unique-prefix>` as shown in the built-in help.

## Loops and execution graphs

Watchdog does not assume that every task is a loop.

When Codex or Pi calls `watchdog_execution`, the Yard uses the declared node names as stations and Operator shows the exact directed edges. A loop is a graph containing a traversed loop-back edge. A subgraph station opens its nested execution with a breadcrumb back to the parent Yard.

Instrumentation can record:

- named nodes and typed edges;
- concurrent node attempts and assigned agents;
- iterations and loop-back traversals;
- verifier policy and results;
- evidence and token/iteration budgets;
- nested executions;
- completed, failed, stopped, blocked, or incomplete outcomes.

Without authoritative instrumentation, Watchdog keeps the task opaque instead of guessing hidden stages.

For scripts and custom orchestrators, the CLI exposes the same execution model:

```bash
watchdog execution declare ./workflow.json
watchdog execution start release-checks audit --agent root --iteration 1
watchdog execution edge release-checks audit-to-test --iteration 1
watchdog execution evidence release-checks "Audit independently confirmed" --node audit
watchdog execution verify release-checks pass "Exit criterion satisfied"
watchdog execution finish release-checks complete
```

Run `watchdog --help` for the complete execution and compatibility-loop command reference.

## Observe an existing Codex session

If Codex was not launched through Watchdog, follow its persisted session JSONL in read-only mode:

```bash
watchdog observe
watchdog dashboard
```

The observer hydrates a bounded recent tail and then follows new records every 500 ms. It can reconstruct persisted topology, tasks, activity, messages, model/effort context, and token usage, but it cannot steer or interrupt the external process.

Use `watchdog observe --once` to reconstruct the latest matching session and exit.

## Reopen a completed run

Every owned or observed run writes an append-only trace under `.watchdog/runs/`.

```bash
watchdog traces
watchdog replay latest
```

While replay remains active, open `watchdog dashboard` or target the printed run ID with `watchdog tui --run <id>`. Replay streams from disk, preserves the recorded topology and execution state, and remains strictly read-only.

## Local-first by design

- Runtime state remains in memory.
- Controls travel over private per-run Unix sockets under `/tmp/watchdog-<uid>/`.
- Active-run registrations live under `~/.watchdog/registry/`.
- Append-only traces live inside the current project at `.watchdog/runs/`.
- The dashboard binds to `127.0.0.1` by default.
- Watchdog does not require an account, hosted backend, or telemetry service.

Your harness provider still receives whatever the underlying Codex or Pi session normally sends to it. Watchdog does not add a separate cloud data path.

## Develop locally

This section is for contributors. Users installing from npm do not need Bun or the source checkout.

```bash
git clone https://github.com/awesamarth/watchdog.git
cd watchdog
bun install
bun run dev -- codex
```

Launch other development surfaces:

```bash
bun run dev -- pi
bun run dashboard
bun run dev -- tui
```

Load the source extension directly into Pi:

```bash
pi --extension ./src/pi/extension.ts
```

Or build and install the checkout into future Pi sessions:

```bash
bun run build
pi install .
```

Use `pi install . -l` for a project-local extension installation.

### Verify a change

```bash
bun run check
bun run test
bun run test:web
bun run build
bun pm pack --dry-run
```

Published output targets ordinary Node.js 22 and must not depend on Bun at runtime.

## Contributing

Bug reports, focused feature proposals, and pull requests are welcome through [GitHub Issues](https://github.com/awesamarth/watchdog/issues). Please preserve adapter capability boundaries: never expose a control the underlying harness cannot truthfully perform.

## License

[MIT](LICENSE)
