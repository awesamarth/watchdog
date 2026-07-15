# Watchdog

Local operator control plane for agentic loops and subagents.

## Current prototype

`watchdog codex` starts a private local Codex App Server, launches the ordinary Codex terminal UI through its `--remote` option, and attaches a second local Watchdog client to the same runtime.

It is not a container and it does not replace Codex. Your normal Codex auth, config, working directory, terminal I/O, and tools remain in use.

Watchdog keeps live normalized state in memory, exposes it through a project-local control socket, and saves an append-only JSONL trace under `.watchdog/runs/`. It tracks recursive agent identity/topology, activity and turn transitions, requested versus effective model/effort, token rollups, loop objective/iteration/verifier/evidence/budgets, and capability-aware controls.

## Run it locally

```bash
bun install
bun run dev -- codex
```

Open the browser dashboard in a second terminal:

```bash
bun run dashboard
```

Then visit `http://127.0.0.1:4242`. The browser receives pushed state over a local WebSocket; the bridge reads the project-local Watchdog control socket. Without a live `watchdog codex` run it opens a clearly marked demo yard, so the visual and interaction model can be explored immediately.

The dashboard has two modes:

- **Yard:** an animated pixel-art rail yard where loops are lines/stations, the root is a locomotive, and every subagent gets a labeled branch car on dynamically composed sidings. Working trains park between semantic stations with intermittent chimney smoke; they move when execution advances instead of pacing decoratively. Click the full-body German shepherd to pet him; click a train to inspect it.
- **Operator:** the same state as an exact execution graph, activity table, configuration comparison, token rollup, and capability-aware controls.

Use the sun/moon button to inspect the day and night palettes. In a live run, selecting an active native child exposes Stop; selecting the active root exposes Stop and Steer.

Forward a normal Codex prompt or options after `codex`:

```bash
bun run dev -- codex "Spawn exactly two subagents: one to map the project, one to identify risks. Do not edit files; return their findings."
```

The terminal remains Codex. Watchdog lifecycle output appears with a `[watchdog]` prefix; its saved trace path is printed at launch. Press `Ctrl+C` to stop the session; Watchdog forwards the signal and stops its local runtime.

In a second terminal in the same project, inspect the live run without leaving the CLI:

```bash
bun run dev -- ps
bun run dev -- tree
bun run dev -- inspect <agent-name>
bun run dev -- tui
```

`watchdog tui` is a small keyboard-first control surface: `j/k` select, `s` steer an active top-level thread, `x` interrupt it, `r` retry a top-level thread, and `q` quit the TUI. Native Codex v2 subagents cannot be given direct input through the App Server, so Watchdog deliberately disables direct steering, retry, and model changes for those children. Direct child stop is supported and was validated against a real sleeping native subagent.

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

The unit suite covers normalized loop state, nested topology, adapter capability gates, JSONL reconstruction, and semantic train motion. The browser test verifies assets, demo-mode loading, mascot interaction, recursive Operator topology, Yard/Operator switching, and day/night rendering with a real Chromium browser.

**Live intervention validation (CLI 0.144.4, 2026-07-15):** a real remote Codex TUI spawned a sleeping native child (`Cicero`). `watchdog stop Cicero` interrupted it, automatically steered the active root, returned `parentNotified: true`, and the root acknowledged the stop and exited its wait without requiring the operator to type a follow-up. Remote mode is interactive-only in this CLI; `codex exec --remote` is not supported.

## Cross-harness adapter boundary

`HarnessAdapter` is the seam for future Pi and Claude Code support. Each adapter identifies its harness, transport, and mode; emits the same normalized `WatchdogEvent` values; and publishes per-agent capabilities for observe, steer, interrupt, retry, and model override. Loop policy, the TUI, and the dashboard consume that contract instead of Codex protocol details.

Both current Codex paths implement it:

- App Server adapter: live events and capability-aware controls for Watchdog-owned runs.
- JSONL adapter: near-live observation with every mutation capability explicitly unavailable.

Pi should implement this interface according to what Pi actually exposes; it must not inherit Codex assumptions merely to make the UI look uniform.
