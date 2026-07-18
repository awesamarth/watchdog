# Watchdog

Local operator control plane for subagents, agentic loops, and execution graphs

## Current prototype

`watchdog codex` starts a private local Codex App Server, launches the ordinary Codex terminal UI through its `--remote` option, and attaches a second local Watchdog client to the same runtime.

It is not a container and it does not replace Codex. Your normal Codex auth, config, working directory, terminal I/O, and tools remain in use.

Watchdog keeps live normalized state in memory, gives every launch a unique run ID and private local control socket, and saves an append-only JSONL trace under `.watchdog/runs/`. Active runs register under `~/.watchdog/registry/`, so several Codex sessions—even in the same project—remain independently addressable. It tracks recursive agent identity/topology, activity and turn transitions, live and completed agent messages, requested versus effective model/effort, token rollups, loop objective/iteration/verifier/evidence/budgets, and capability-aware controls.

## How Codex and GPT-5.6 were used

Watchdog was designed, built, debugged, and validated in the Codex CLI with GPT-5.6. Codex was the only AI coding agent used during development—and, because Watchdog integrates with Codex, it served as both the development collaborator and the live system under test.

- **Product and architecture:** Codex helped turn the initial subagent-observability idea into a local-first control plane spanning subagents, agent loops, and execution graphs, then pressure-tested the scope and capability boundaries.
- **Implementation:** GPT-5.6 worked across the TypeScript runtime, Codex App Server adapter, normalized event model, control sockets, CLI, Ink TUI, React/Vite dashboard, tests, and documentation.
- **Codex integration research:** Codex inspected and exercised its own public runtime surfaces to map thread topology, streamed activity, requested-versus-effective model and reasoning configuration, token usage, and the controls actually available for roots and native children.
- **Live validation:** Development sessions spawned real native Codex subagents, inspected their activity through Watchdog, interrupted them from a separate control surface, and verified automatic parent notification. Those rehearsals exposed timeout and nested-parent reporting gaps that were fixed and covered by tests.
- **Continuous dogfooding:** Watchdog is developed through `watchdog codex`, so new observability and intervention features are tested against the same workflow they are intended to improve.

## Run it locally

```bash
bun install
bun run dev -- codex
```

Open the browser dashboard in a second terminal:

```bash
bun run dashboard
```

Then visit `http://127.0.0.1:4242`. The browser receives pushed state over a local WebSocket and can switch among every active live run from its session picker. The selected harness is explicit in both Yard and Operator (`WATCHING CODEX`, and later Pi, Claude Code, or OpenCode). The root page never mixes in simulations; without a live run, it reports that there are no running sessions and links to the read-only demo at `http://127.0.0.1:4242/demo`.

For a deterministic, interactive rehearsal with warnings and working controls:

```bash
bun run demo
```

This starts an explicitly labeled simulation at `/demo` with working rehearsal controls; it never appears as a live session on `/` or pretends that mock activity came from Codex. See [the demo rehearsal](docs/demo-rehearsal.md) for the reliable story and the corresponding real-Codex run.

The dashboard has two modes:

- **Yard:** an animated pixel-art rail yard where an ordinary task runs from `START` to `END`, explicit loops become semantic lines/stations, the root is a right-facing locomotive, and every subagent gets a labeled branch car on a perpendicular spur. Children alternate above/below the main line, remain parked away while working, and move toward it when complete; crowded sidings scale the cars down without imposing a fixed agent limit. Click the full-body German shepherd to pet him; click a train to inspect that exact agent's assignment, current activity, live response, timestamped message history, model/effort, and tokens.
- **Operator:** the same state as an exact execution graph, activity table, configuration comparison, token rollup, and capability-aware controls.

Use the sun/moon button to inspect the day and night palettes. In a live run, selecting an active native child exposes Stop; selecting the root exposes capability-aware Stop, Steer, and interrupt/retry controls with optional next-turn model and reasoning-effort overrides.

Forward a normal Codex prompt or options after `codex`:

```bash
bun run dev -- codex "Spawn exactly two subagents: one to map the project, one to identify risks. Do not edit files; return their findings."
```

The terminal remains Codex. Watchdog prints its run ID and log locations before the Codex UI starts, then leaves the active screen entirely to Codex—live Watchdog events never compete with its terminal renderer. Normalized events go to the saved JSONL trace and control surfaces; App Server diagnostics go to the adjacent `.diagnostics.log`. Press `Ctrl+C` to stop the session; Watchdog forwards the signal and stops its local runtime.

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
bun run dev -- tui --run codex-mh2
```

`watchdog tui` is a small keyboard-first control surface with pane-aware navigation. The Run Tree is focused first, where arrows or `j/k` select an agent. `Tab` or `→` focuses the Inspector, where those keys scroll one line and Page Up/Down scroll half a viewport; `Tab`, `←`, or Escape returns to the tree. Home/End jump within the focused pane and `q` quits. The footer lists only controls the selected agent actually supports, with explicit labels such as `s steer`, `x stop`, and `r retry`. Native Codex v2 subagents therefore show only `x stop` while active; unsupported steering, retry, and model changes stay hidden. Direct child stop was validated against a real sleeping native subagent.

Declare loop intent and proof explicitly from either the CLI or dashboard:

```bash
bun run dev -- loop set root --verifier "all tests pass three times" --token-budget 120000 --max-iterations 5
bun run dev -- loop evidence root "Regression suite passed on the candidate fix"
bun run dev -- loop verify root pass "Exit criterion satisfied"
```

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

The unit suite covers normalized loop state, nested topology, adapter capability gates, JSONL reconstruction, multi-run registration/control routing, and semantic train motion. The browser test launches two simultaneous runtimes, switches between them, and verifies assets, demo-mode loading, mascot interaction, recursive Operator topology, Yard/Operator switching, and day/night rendering with a real Chromium browser.

**Live intervention validation (CLI 0.144.4, 2026-07-15):** a real remote Codex TUI spawned a sleeping native child (`Cicero`). `watchdog stop Cicero` interrupted it, automatically steered the active root, returned `parentNotified: true`, and the root acknowledged the stop and exited its wait without requiring the operator to type a follow-up. Remote mode is interactive-only in this CLI; `codex exec --remote` is not supported.

Control requests are bounded: local Watchdog socket actions time out instead of hanging forever, Codex RPC requests have their own deadline, and an unexpected App Server disconnect rejects pending work immediately. For a nested `root → child → grandchild` stop, Watchdog notifies the steerable root but reports `parentNotified: false` because Codex does not permit direct input to the immediate native-child parent.

## Cross-harness adapter boundary

`HarnessAdapter` is the seam for future Pi and Claude Code support. Each adapter identifies its harness, transport, and mode; emits the same normalized `WatchdogEvent` values; and publishes per-agent capabilities for observe, steer, interrupt, retry, and model override. Loop policy, the TUI, and the dashboard consume that contract instead of Codex protocol details.

Both current Codex paths implement it:

- App Server adapter: live events and capability-aware controls for Watchdog-owned runs.
- JSONL adapter: near-live observation with every mutation capability explicitly unavailable.

Pi should implement this interface according to what Pi actually exposes; it must not inherit Codex assumptions merely to make the UI look uniform.
