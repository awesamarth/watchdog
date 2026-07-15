# Build Week Project Context

## Working agreement

This file is the durable context for this hackathon project. Read it before planning, researching, or implementing. Update it after any material product decision, technical discovery, validated experiment, or scope change. Keep it factual; mark assumptions and unresolved questions explicitly.

## Project thesis

Build a local-first, harness-agnostic observability and intervention layer for **agentic loops and subagents**.

It is not a new agent harness and not a generic log dashboard. It should help an operator understand and control autonomous coding work once it branches beyond a single agent.

Initial harness priorities:

1. Codex — first adapter and primary OpenAI Build Week demo.
2. Pi — next adapter; its package/extension ecosystem is a strong fit.
3. Claude Code — later adapter; do not assume its capabilities map directly to Codex.

Pi is design inspiration for minimalism, transparency, and user control. Herdr is relevant adjacent infrastructure, not the product: it provides cross-harness terminal panes and coarse agent state, while this project provides semantic loop/subagent visibility and intervention.

## User problem

Subagents and long-running loops become difficult to trust once work fans out. Operators lose track of:

- the loop's goal, state, verifier, and progress across iterations;
- why subagents were spawned, what each is doing, and whether branches overlap or stall;
- model, reasoning effort, token/cost consumption, and runaway fan-out;
- where and how to intervene safely.

The core promise is a single control surface that answers:

1. What is this system trying to accomplish?
2. What loops and subagent branches exist, and why?
3. Which branches are progressing, duplicating work, or stalled?
4. What is the token/cost footprint?
5. What intervention is available right now?

## Concrete user-visible footgun to demo

A user-provided report describes a subagent orchestration trap: a parent can request a cheaper/different subagent model, yet a full-context fork (`fork_turns: all`) may prevent the actual model switch unless the spawn uses `fork_turns: none` or a bounded positive value. If the UI hides the actual model and reasoning effort, the resulting quota/cost surprise is invisible.

Treat the exact model names and current product behavior as externally reported until independently verified. The product implication is solid: Watchdog must show **requested versus effective** model, reasoning effort, context/fork strategy, and token usage on every child node wherever the harness exposes them. This is an excellent Codex-first demo: surface a costly mismatch and make its cause legible, rather than merely showing a tree.

User-provided social-post evidence is saved in `docs/research/tweet-evidence.md`. Verify originals before using any quote or attribution publicly.

## Competitive gut check — 2026-07-14

Do **not** pitch Watchdog as the first cross-harness local observability dashboard. `Agents Trail` already markets a local, read-only dashboard for Codex, Claude Code, OpenCode, OpenClaw, and Qoder with JSONL/SQLite ingestion, session replay, tool-call inspection, subagent trees, and token/cost tracking. Its own site says the dashboard is read-only. A similarly positioned project called Harness Observability Layer also advertises local inspection of archived Codex/Claude sessions.

Codex itself is also moving toward live multi-device work: OpenAI's May 2026 announcement describes live thread state, approvals, model changes, and steering from the ChatGPT mobile app. Assume native Codex visibility/control will keep improving.

**Watchdog's defendable hackathon wedge:** a loop-first operator control plane for multi-agent execution, not a replay dashboard:

- launch Codex through Watchdog's shared App Server for real-time, capability-aware steer/interrupt;
- make loop state legible: objective, iteration, verifier/exit criterion, evidence, progress, and budget;
- make orchestration legible within each iteration: requested vs effective model, reasoning effort, context/fork strategy, child purpose, spend, and evidence/progress;
- identify and act on runaway loops, runaway fan-out, duplicate/stalled branches, and failed/absent verification;
- support cross-harness adapters over time while being honest about each adapter's controls.

The demo must visibly show an intervention or explainable warning that a read-only trace product cannot produce. Preferred narrative: Watchdog shows a loop consuming budget without satisfying its verifier, reveals costly/duplicative behavior inside the current iteration, then lets the operator stop or steer the next action. Avoid a generic analytics-dashboard pitch.

## Product boundary

Watchdog is **loop-first**, not merely a subagent dashboard. A long-running agentic loop is the top-level unit: an objective is pursued through repeated iterations, each with a plan/action, optional delegation, collected evidence, verification, and a decision to continue, change course, or stop. Subagents are one execution mechanism *inside* an iteration.

The product should model two connected views of the same execution data:

- **Loop view (primary):** goal → iteration → plan/act/delegate → collect evidence → verify → next iteration, intervention, or done. Show iteration number, exit/verification criteria, budget, latest evidence, and progress toward the goal.
- **Subagent graph (drill-down):** the parent/child task tree for a selected iteration, with each node's role, status, model, reasoning effort, latest action/artifact, token use, and cost estimate.

Controls should be capability-aware. Support direct steering, interrupt/stop, and retry/rerun with changed model or reasoning effort when the underlying harness permits it. Never advertise a control that an adapter cannot actually perform.

Watchdog must be **terminal-first as well as dashboard-capable**. The dashboard is an optional rich topology/timeline view, not the only control surface. A Watchdog-owned run should expose a local control channel that a second terminal can use for concise commands such as `watchdog ps`, `watchdog tree`, `watchdog steer <agent> "..."`, and `watchdog stop <agent>`. Later, an optional local MCP server/plugin can give the parent Codex agent the same capability-aware tools (`list`, `inspect`, `steer`, `interrupt`) in chat. Do not assume Codex supports a custom native `/watchdog` slash command; use the supported CLI/MCP surfaces. The second-terminal CLI is the reliable immediate-intervention path while the main Codex turn is busy.

Do not scope cross-harness prompt handoff as the MVP. “Cross-harness” means one tool understands separate Codex, Pi, and Claude Code runs through a normalized adapter model.

## Codex technical findings

The locally installed CLI is `codex-cli 0.144.4`. Its generated App Server schema exposes relevant local JSON-RPC surfaces:

- `thread/list` and `thread/read` for local task discovery/history;
- `parentThreadId` on subagent threads;
- collaboration/spawn records with sender/receiver thread IDs, prompt, requested model, requested reasoning effort, and status;
- subagent activity records;
- thread status and token-usage notifications, including reasoning-output tokens;
- `turn/steer` for a targeted active `threadId` (with active-turn precondition);
- `turn/interrupt` for a targeted thread/turn;
- per-turn `model` and `effort` overrides that apply to later turns in that thread.

Schema validation detail (2026-07-14): a `collabAgentToolCall` event carries the **requested** child `model` and `reasoningEffort`, plus sender/receiver thread IDs and prompt. `thread/resume({ threadId })` returns that thread's active `model` and `reasoningEffort`; treat those as the effective configuration Watchdog should show, after a targeted runtime confirmation. `turn/steer` takes `threadId`, `expectedTurnId`, and input (and fails safely if the active turn no longer matches or is not steerable). `turn/interrupt` takes `threadId` and `turnId`. This gives Watchdog a direct capability-aware path for child steering/stopping in Watchdog-owned remote sessions, without terminal-key injection. A child cannot be hot-swapped during an active turn: interrupt/finish it, then use `turn/start({ threadId, input, model, effort })` to launch its next turn with the selected model/effort. `thread/fork` can make a separate retry branch with a model override; apply its effort through that new thread's `turn/start`.

Codex already provides custom agent profiles, model/reasoning defaults, max thread/depth limits, orchestration, and basic subagent inspection. Do not reimplement these. Build the operator-oriented graph, loop semantics, rollups, policies, and control UX on top.

**Native `/subagents` validation (CLI 0.144.4, 2026-07-14):** `/subagents` (rendered as `/agent`) lists currently running child agents with their path, live status text, and current command/tool—for example two `/root/wait_*` children both showing `sleep 30`. It is useful native inspection and Watchdog must not clone that list as its pitch. In this live test, typing the command during an active root turn did not immediately open the list; after interrupting the root turn it displayed while the children continued. Do not claim it is an independent concurrent operator surface without further testing. The native list did **not** display model/reasoning effort, token/cost rollups, loop verifier/progress, warnings, or explicit child steer/stop controls. Watchdog's role is the cross-thread/cross-harness control plane above this native detail view.

## Proposed Codex-first architecture

The core should be a local TypeScript sidecar/dashboard, distributable as an npm CLI (for example `npx watchdog`), not merely a Codex plugin.

```text
Codex CLI (remote mode) <-> Codex App Server <-> Watchdog TypeScript sidecar <-> localhost browser dashboard
```

The sidecar should:

1. connect to the local Codex App Server;
2. discover/read relevant threads and ingest event notifications;
3. normalize the execution into local durable state (SQLite or similarly simple local storage);
4. render the live loop and subagent views in a local web UI;
5. route explicit user controls back through the App Server.

An optional Codex plugin/MCP integration can come later to let a main Codex agent query Watchdog status or open the dashboard. It is convenience glue, not the observability/control substrate.

### Explaining remote mode in the demo

`watchdog codex` does not run Codex in a container or replace its harness. It starts one local Codex App Server, then launches the user's normal Codex CLI with `--remote` pointed at that server's private Unix socket. The terminal UI, Codex auth, project config, tools, sandbox, and working directory remain Codex's; Watchdog is simply a second local client of the same runtime. That shared runtime is why Watchdog receives live events and can send supported control requests.

Use a Unix socket, not a TCP port, in the product: it is private to the local machine and avoids a listening network service. **Current CLI 0.144.4 spike caveat:** its Unix listener did not accept a standard `ws` client handshake, while loopback `ws://127.0.0.1:<ephemeral-port>` works. The first prototype therefore uses an ephemeral loopback listener; keep the socket goal open and solve it through Codex's compatible Unix transport later. Watchdog must forward CLI arguments, terminal I/O, exit status, and signals faithfully so this feels like ordinary Codex.

### Agent identity requirement

Track every available identity field, even if the first terminal prototype does not render them yet: `agentThreadId`, `parentThreadId`, `agentPath`, `agentNickname`, and `agentRole`. Codex can supply nicknames/roles for AgentControl-spawned threads; use the path as the stable fallback label. This will later let Watchdog make a live graph feel memorable and readable rather than anonymous boxes.

## Chosen implementation stack

Use TypeScript end to end.

- **CLI/runtime:** Node.js 22-compatible TypeScript, developed with Bun if convenient, bundled for npm with `tsup`. Use the Node runtime as the compatibility target; Watchdog must not require users to install Bun.
- **Terminal operator UI:** React Ink (`ink`) plus small focused Ink components. It can run under Bun during development and ordinary Node 22 for consumers. Do not use OpenTUI for the MVP: its native renderer currently requires Bun or Node 26.4+ with experimental FFI, which conflicts with the Node 22 compatibility target.
- **Dashboard:** React + Vite. Vite is for the frontend build/dev experience; the published CLI serves the generated static assets from a local HTTP server. Do not use Next.js: SSR, routing, and deployment machinery add no value to a local companion dashboard.
- **Local server/event bridge:** a small Node HTTP/WebSocket server. It connects to Codex App Server over the local Unix socket, normalizes events, and pushes a compact Watchdog event stream to the browser.
- **Styling:** Tailwind is acceptable for speed, but prefer a small intentional visual system over a heavy component kit. The UI should feel like an operator console, not an admin dashboard.
- **Persistence:** begin with in-memory run state plus append-only local Watchdog event files. Add SQLite only if filtering/replay needs it; do not spend hackathon time on a database migration layer or native dependency complexity.

Suggested repository shape when implementation begins:

```text
src/cli.ts                 # watchdog codex / observe / loop commands
src/codex/                 # App Server launch, protocol client, normalizer
src/runtime/               # process lifecycle, loop supervisor, capabilities
src/server/                # localhost HTTP + browser WebSocket bridge
web/                       # Vite React dashboard
```

## Validated Codex adapter spike — 2026-07-14

Used a separate `codex app-server --stdio` process as a local sidecar client.

**Passed:**

- It discovered this current ChatGPT desktop/CLI-originated project session by `cwd` using `thread/list` and read its persisted history using `thread/read`.
- In a disposable sidecar-created Codex thread, it received live JSON-RPC notifications for native subagents: `subAgentActivity` with child thread IDs, child status changes, child turn start/completion, streamed output deltas, parent wait activity, and per-thread token-use/rate-limit updates.
- The parent orchestrator exposed the native collaboration calls and child paths (`/root/agent_a`, `/root/agent_b`) in the stream. This is sufficient raw material for a live parent/child graph, activity timeline, and token rollups.

**Operational note:** `codex app-server daemon start` did not work with this Bun-installed CLI because the managed standalone binary was absent. Starting and owning `codex app-server --stdio` directly works, so the MVP sidecar should do that rather than depend on the daemon.

**External attachment result (keep this narrow and explicit):**

This was tested with the **actual Codex CLI** (not the desktop app): while a separate `codex exec` process ran a task that spawned two native subagents, the already-connected App Server client received **no** live events. The completed external session was persisted to `~/.codex/sessions/` and was readable afterward by known thread ID, including `subAgentActivity` and child IDs, but it did not appear in that sidecar's live notification stream or normal `thread/list` response.

Conclusion: a standalone App Server process is not a shared global event bus for other Codex CLI processes. Do not promise universal live attachment through this route.

For Codex, full live/control mode needs a Watchdog-owned/instrumented execution path. The implemented JSONL observer provides best-effort near-live, read-only visibility for external CLI sessions by following the selected root session and its children. It cannot provide reliable direct intervention. Whether a desktop-owned run exposes any additional shared live surface remains untested and is not part of the CLI-first promise.

## Validated preferred Codex execution path — 2026-07-14

There is a materially better path than relying on JSONL files for the main experience:

```text
Watchdog starts `codex app-server --listen <local socket>`
Codex CLI launches with `codex --remote <same socket>`
Watchdog dashboard is a second App Server client
```

This was tested over a loopback WebSocket (use a Unix socket in the product). A remote Codex CLI TUI spawned two native subagents; Watchdog's separate client received the root thread creation, live child-thread status/turn events, streamed child output, and token updates. The CLI remains the CLI the participant knows; Watchdog owns the shared runtime rather than replacing it with another harness.

This is the preferred MVP path because the App Server exposes `turn/steer` and `turn/interrupt` to connected clients for active turns. It makes real intervention feasible for sessions launched through Watchdog. Model/reasoning controls apply on subsequent turns; a running agent's model cannot be magically swapped in-place.

**New control-limit validation (2026-07-15):** Codex rejects both `turn/start` and `turn/steer` sent directly to a native multi-agent-v2 child with `direct app-server input is not allowed for multi-agent v2 sub-agents`. `turn/interrupt` **does** work: Watchdog stopped a real native child while it was running `sleep 120`. Therefore direct child retry/fork-with-new-model and direct child steering are **not** valid initial capabilities. Watchdog must capability-gate them: root threads may receive a subsequent turn, while native children offer direct stop only until Codex exposes a supported parent-orchestrator control route. Do not market direct child model switching or direct steering.

Command UX: use `watchdog codex` (and later `watchdog pi`, `watchdog claude`) as the canonical launcher. A Codex plugin cannot add a native `codex --watchdog` flag; at most, Watchdog could offer an optional user-installed shell alias such as `codexw`. Do not make shell mutation a prerequisite or pretend the standard Codex binary supports a Watchdog flag.

Normal pre-existing `codex` / `codex exec` processes cannot be retroactively connected to Watchdog's server. For those, treat file watching as a best-effort observability fallback only; do not offer reliable steer/stop controls. Do not use terminal-key injection as a product control mechanism.

## Near-term build sequence

1. Make `watchdog codex` the Codex MVP entry point: start a local App Server and launch/attach Codex CLI through `--remote` (Unix socket in production).
2. Build a minimal local Codex adapter using the validated event stream and normalize parent/child/activity/token events.
3. Render a live parent/child graph with token rollups and capability-aware `steer` / `interrupt` for Watchdog-owned tasks.
4. Add loop-level goal/verifier/iteration presentation and fan-out warnings.
5. Spike a filesystem watcher over Codex session JSONL as an explicitly best-effort, read-only fallback for existing external CLI sessions.
6. Design the normalized adapter interface before implementing Pi; do not force Pi into Codex-specific semantics.

**Status (2026-07-15): all six items above are implemented and tested.** Distribution/package polish is the next product step; Pi remains a later adapter, not unfinished Codex MVP work.

## Current project state

- This is an OpenAI Build Week project.
- The project is now a local Git repository on branch `main`; no initial commit has been created yet.
- Hackathon helper state and early ideation notes live in `.devpost-hackathon-state.json` and `docs/hackathon-build/`.
- Steps 1–6 of the first prototype are implemented: Bun-managed TypeScript scaffold; `watchdog codex` remote launcher; Codex App Server normalizer; recursive in-memory run/loop state; local control socket; terminal commands (`ps`, `tree`, `inspect`, `steer`, `stop`, `retry`, and loop metadata commands); Ink TUI; browser dashboard; JSONL observer fallback; and the harness-neutral adapter boundary. It forwards ordinary Codex terminal I/O and writes normalized JSONL traces to `.watchdog/runs/` (ignored by Git).
- The prototype's loopback remote runtime was smoke-tested with a real Codex session that spawned two native children. The saved trace correctly contained root → `Locke` and root → `Kepler` edges, per-child thread lifecycle, and token updates. Important protocol discovery: `subAgentActivity` is emitted in a child context and can point back to its parent, so the normalizer derives graph edges from `thread/read.parentThreadId` rather than trusting that activity item for direction.
- The browser dashboard is implemented and served locally; `bun run check`, unit tests, Playwright tests, and the production build pass as of 2026-07-15.
- Ink was smoke-tested under the installed Bun runtime (rendered a real colored terminal component and exited cleanly). The interactive TUI necessarily requires a real TTY; a non-TTY invocation correctly reports Ink raw-mode unsupported. Keyboard/raw-mode and alternate-screen behavior still need one real-terminal validation.
- Real-TTY validation is now complete: `bun run dev -- tui` connected to a live `watchdog codex` run, rendered the run tree/inspector, and exited cleanly with `q`. The current loop objective fetch uses a small bounded retry because `turn/started` can arrive before its input is readable from history.
- Native-control validation is complete for a live sleeping child. Direct child `steer` and direct child `retry` return the expected Codex restriction and are disabled in every surface; direct interrupt works.
- Root steering and automatic parent wake-up are now validated in a fresh real Codex TUI run (2026-07-15). A native child named `Cicero` was interrupted through `watchdog stop Cicero`; Watchdog returned `parentNotified: true`, the root immediately acknowledged that Watchdog had stopped the child, stopped waiting, and completed without manual operator follow-up. The active-turn hydration/retry path therefore works for this intervention. Codex remote mode is interactive-only in CLI 0.144.4; `codex exec --remote` is not supported.
- External-session fallback is implemented as `watchdog observe`: it tails the selected root session and matching child JSONL files every 500 ms, reconstructs topology/activity/effective config/tokens/objective/evidence, and exposes the same snapshot to the TUI/dashboard. It is intentionally read-only and capability-gated.
- Loop semantics are implemented: objective, phase, iteration, verifier, evidence, verification result, token/iteration budgets, descendant rollups, and warnings for missing proof, fan-out, duplication, budgets, and requested/effective config mismatches. Nested loops and arbitrarily deep child topology are represented recursively.
- The cross-harness boundary is implemented as `HarnessAdapter`. Adapters emit normalized events and publish per-agent observe/steer/interrupt/retry/model-override capabilities. Codex App Server and Codex JSONL both implement it; future Pi work should start here rather than importing Codex protocol assumptions.
- Do not create a generic agent framework or a broad SaaS platform. Keep the first demo local, credible, and visibly useful.

## Dashboard visual direction — decided 2026-07-15

The browser dashboard has two renderings of the same live run:

- **Yard** (default): an interactive, whimsical pixel-art rail yard that makes loop progress and intervention memorable.
- **Operator**: a dense, conventional graph/timeline/inspector view for detailed debugging.

The Yard is not a copy of Herdr Flock's sheep farm. Its visual metaphor is selected because it explains Watchdog's two independent concepts:

- Each **loop** is a named rail line; meaningful steps/iterations become stations (plan, execute, verify, retry, done).
- The main agent is a locomotive. Subagents are carts/sidecars that take branch tracks, perform work, and return evidence. Nested loops become branch lines.
- A verifier is a signal/checkpoint: green pass, red fail. Tokens/cost map to fuel/load. A stalled agent stops under a warning lamp; runaway/retry loops visibly circle with an alarm.
- Steer maps to a railway switch; stop maps to a red signal. A native-child stop should visibly halt its cart and re-route/wake the parent.

Atmosphere: a small procedural yard (grass, trees, sheds, water tower, tracks) with subtle day/night palette shifts and optional gentle weather. Never let atmosphere obscure operational state.

**Watchdog mascot:** a friendly, capable German shepherd visible in full in the signal tower/window area — not just a lighthouse-style floating face. It should be actual pixel sprites, not React/CSS-drawn shapes. Use a compact 32×32 or 48×48 sprite with pose and expression composited independently:

- Poses: idle breathing/slow blink, scanning, lever pull, celebrate, alert.
- Expressions: neutral, focused, happy, worried, alarmed.
- Highest-priority unresolved run state chooses expression; do not flicker through every event.
- Verifier pass/meaningful resolved win: happy face, tail wag, 2–3 small pixel hearts rising for about 0.8s. Do not trigger hearts for every tool call.
- Clicking the dog performs a harmless pet animation (head scratch/lean, tail wag, hearts); no tooltip, no sound, and it must not acknowledge/dismiss real alerts. Clicking the tower/nameplate/status strip opens the overall run inspector instead.

Implementation intent: pixel world rendered with a lightweight canvas renderer; React/Vite renders panels, filters, controls, and the Operator mode. Asset generation is available when implementation begins.

### Dashboard implementation status — 2026-07-15

The first usable dashboard is implemented.

- `watchdog dashboard` / `bun run dashboard` builds and serves the browser UI at `http://127.0.0.1:4242`.
- A local Node bridge reads the project control socket on a short internal interval and pushes changed snapshots to browsers over WebSocket. Explicit browser controls are forwarded to the control socket. If no live run exists, the server returns a conspicuously labeled demo snapshot; demo controls remain disabled.
- Yard is a real animated canvas scene with generated pixel assets, composable rail tiles/stations, active/idle vehicle animation, selection hit regions, pet interaction with small white hearts, day/night palettes, warning display, and an always-visible full-body shepherd inside an open signal tower. The full four-frame hand/pet animation is enabled. Mascot frames use one fixed scale and foot baseline; three pet cells contain stray pixels from the following atlas row, so their explicit crop bounds exclude those pixels to prevent the real dog from being lifted. Canvas cursor behavior is contextual: normal over scenery, pointer only over the dog, tower, and trains.
- Train art is a reusable role/livery atlas, not a four-agent limit. Every live child gets its own labeled vehicle; the layout creates branch rows from current agent count and reuses investigator/verifier/reviewer liveries by semantic role. The demo renders seven descendants, including a nested child, to exercise recursive topology.
- Train motion is semantic. Active root work parks midway between the relevant stations; completed work eases to its checkpoint. Child cars stay at their work location and shift only after completion. There is no elapsed-time left/right pacing. Smoke is a separate four-frame sprite layer with a staggered duty cycle, so active work is visible without moving the vehicle.
- Operator renders the same recursive topology, activity list, requested/effective config comparison, token rollup, task detail, loop verifier/evidence/budgets, and adapter-provided capability-aware controls.
- Project assets live under `web/public/assets/`: `watchdog-logo.png` and sized logo/favicon variants; `watchdog-sprites.png` (4×4 pose/expression sheet); `train-sprites.png` (4×2 engine/cart sheet); `smoke-sprites.png` (4×1 transparent smoke animation); `signal-tower-v2.png` (open full-body mascot station); `track-atlas.png`; `cloud-atlas.png`; and `yard-backdrop.png`. Raster assets were generated with the built-in image-generation path on chroma key where needed, then locally converted to alpha.
- Playwright validation covers asset loading, demo labeling, contextual cursor hit-testing, mascot pet interaction, recursive graph content, Yard/Operator switching, and day/night rendering. Unit tests also cover loop semantics, JSONL reconstruction, adapter capability gates, and semantic train targets. `bun run test`, `bun run test:web`, `bun run check`, and `bun run build` pass.

Current limitations to preserve honestly: the browser uses pushed WebSocket state, but the Node bridge still samples the project control socket every 300 ms; JSONL attachment to external Codex runs is best-effort and read-only; native Codex children can be interrupted but cannot receive direct steering/retry/model changes; automatic evidence capture is currently agent-message based and can be supplemented manually; Pi and Claude adapters are not implemented yet.
