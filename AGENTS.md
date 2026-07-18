# Watchdog — Durable Project Handoff

## How to use this file

This is the first file an agent should read in a fresh session. It should answer: what are we building, why is it different, what already works, what is genuinely validated, and what should happen next.

Update it after a material product decision, technical discovery, validation, or scope change. Keep it current rather than chronological. Remove superseded information instead of accumulating history. Mark assumptions and unresolved questions honestly.

Before editing:

- Run `git status --short`; the working tree contains valuable uncommitted work.
- Preserve user-tuned dashboard assets and animation coordinates unless the task explicitly concerns them.
- Use Bun for local development. Published output must run on ordinary Node.js 22 without requiring Bun.
- Do not commit or push unless the user explicitly asks.

## Mission

Watchdog is an OpenAI Build Week developer-tooling project. The user cares strongly about having a real chance to win; optimize for a crisp, credible product and memorable demo rather than breadth.

Build a **local-first, harness-agnostic operator control plane for agentic loops and subagents**.

Harness order:

1. Codex — current adapter and primary hackathon demo.
2. Pi — next adapter and an especially promising control surface.
3. Claude Code.
4. OpenCode and other harnesses later.

“Cross-harness” means Watchdog can understand separate runs from multiple harnesses through one normalized model. It does **not** mean sending one prompt through several harnesses.

Watchdog is not:

- another agent harness;
- a generic log/replay dashboard;
- a terminal multiplexer or remote-process manager;
- a broad SaaS platform.

## User problem and product promise

Autonomous coding becomes difficult to trust once work loops or branches. Operators lose track of the goal, exit criterion, iterations, child purpose, duplicate work, model/reasoning choices, token/cost consumption, and safe intervention points.

Watchdog should answer:

1. What is the system trying to accomplish?
2. Which loops and branches exist, and why?
3. Which branches are progressing, duplicated, stalled, or failing verification?
4. What are the token/cost and fan-out consequences?
5. Which controls are truly available right now?

The primary model is **loop-first**:

```text
objective → iteration → plan/act/delegate → evidence → verify → continue/steer/stop/done
```

Subagents are one execution mechanism inside an iteration. Loops and subagents intersect but are not the same: the root can loop without children, a loop can spawn children, a child can run a nested loop, and a parent can coordinate several loops.

Two views represent the same normalized run:

- **Loop view:** objective, iteration, phase, verifier/exit criterion, evidence, budget, progress, and warnings.
- **Subagent graph:** recursive parent/child topology, role, status, task, requested/effective configuration, latest activity, tokens, and capabilities.

Controls must be capability-aware. Never display or market steering, retry, model change, or interruption when the active adapter cannot perform it.

The product is terminal-first **and** dashboard-capable:

- second-terminal commands: `runs`, `ps`, `tree`, `inspect`, `steer`, `stop`, `retry`, and loop commands;
- Ink TUI for keyboard-first inspection/control;
- browser Yard and Operator views;
- a possible local MCP/plugin later so the parent agent can query Watchdog from chat.

Do not assume Codex can add a native `codex --watchdog` flag or `/watchdog` command. The canonical launcher is `watchdog codex`; later launchers can be `watchdog pi`, `watchdog claude`, etc.

## Positioning and competition

Do not claim “first cross-harness observability dashboard.”

- **Herdr** manages independent top-level coding-agent processes in terminal panes with focus/attach/input and coarse state. Watchdog should not rebuild panes, tmux-like persistence, SSH, or remote session management. The products can compose: `watchdog codex` can run inside a Herdr pane.
- **Agents Trail** and similar projects already offer local read-only session replay, subagent trees, tool calls, tokens, and costs across multiple harnesses.
- **Codex `/subagents`** already lists native children and current activity.
- Native Codex visibility/control will continue improving.

Watchdog’s defensible wedge is a **loop-first live intervention layer**: verifier/evidence/budget semantics, requested-versus-effective configuration, fan-out/duplication warnings, and supported controls against the live runtime.

The demo must visibly do something a replay dashboard cannot: explain a bad loop/orchestration state and intervene. Do not pitch “look, a tree.”

User-provided social evidence is stored locally in `docs/research/tweet-evidence.md`. Verify original posts before publishing quotes or attribution.

## Architecture and stack

```text
Codex CLI --remote
        ↕
Codex App Server
        ↕
Codex adapter → normalized events → RuntimeState
                                      ↕
                         per-run Unix control socket
                                      ↕
                 CLI / Ink TUI / dashboard bridge
                                      ↕
                         React/Vite browser UI
```

- TypeScript end to end.
- Bun for local scripts/package management.
- Node.js 22 compatibility target; `tsup` bundles the npm CLI.
- React Ink for the TUI. Do not switch to OpenTUI for the MVP because its runtime requirements conflict with Node 22 compatibility.
- React + Vite dashboard; no Next.js.
- Plain intentional CSS currently powers the dashboard; Tailwind is not installed.
- Small Node HTTP/WebSocket bridge serves built static assets and pushes snapshots.
- In-memory normalized state plus append-only `.watchdog/runs/*.jsonl`; no SQLite unless replay/filtering genuinely requires it.
- `HarnessAdapter` is the cross-harness seam. UI and policies consume normalized events/capabilities, not Codex protocol types.

Important locations:

```text
src/cli.ts                    commands and argument routing
src/adapters/types.ts         normalized adapter contract
src/codex/                    App Server protocol, adapter, JSONL observer
src/runtime/state.ts          recursive agent/loop state and warnings
src/runtime/control.ts        control protocol and run selection
src/runtime/registry.ts       global active-run registry
src/runtime/codex.ts          watchdog codex launcher
src/runtime/observe.ts        external JSONL fallback
src/runtime/demo.ts           deterministic rehearsal runtime
src/server/dashboard.ts       dashboard server/run catalog/control routing
src/tui/                      Ink UI
web/src/App.tsx               dashboard shell, Operator, controls
web/src/Reveal.tsx            standalone screenshot-ready title reveal
web/src/YardCanvas.tsx        pixel Yard renderer and interactions
web/public/assets/            generated/tuned pixel assets
```

## What is implemented now

- `watchdog codex` starts a loopback-only Codex App Server, connects Watchdog, and launches the ordinary Codex TUI with `codex --remote`. Auth, config, cwd, tools, sandbox, terminal I/O, exit status, and signals remain Codex’s.
- Live normalization covers roots/children, recursive topology, Codex nicknames/roles/paths, generic task input, native command/MCP/search/file/sleep activity, streamed and completed agent messages, requested/effective model and reasoning effort, tokens, and explicit loop objective/phase/iteration/verifier/evidence/budgets/warnings. Child assignments are hydrated from the parent collaboration record when the live spawn event races persistence.
- Controls: capability-aware root steering/interruption/retry and native-child interruption. Loop metadata/evidence/verification can be updated from CLI or dashboard.
- Stopping a native child can automatically notify/wake the waiting parent.
- `watchdog observe` tails persisted Codex JSONL every 500 ms for best-effort near-live observation of ordinary external Codex sessions. It is deliberately read-only.
- Terminal surface: `watchdog runs`, `ps`, `tree`, `inspect`, `steer`, `stop`, `retry`, `loop ...`, and `tui`.
- Browser surface: Yard, Operator, session picker, adapter identity, controls, `/demo`, empty live Yard, day/night mode, and a standalone `/reveal` title card.
- `watchdog doctor` checks Node, Codex, packaged dashboard assets, and active project runtimes without mutating the project.
- `watchdog demo` is an explicitly labeled deterministic simulation using the same adapter → state → socket → dashboard path. It is for rehearsal/test reliability, not proof of Codex behavior.

### Multi-run behavior

Every `codex`, `observe`, and `demo` launch gets:

- a unique run ID;
- a private Unix control socket;
- an atomic record under `~/.watchdog/registry/`.

Control sockets use short hashed paths under `/tmp/watchdog-<uid>/` because macOS rejects long Unix-domain socket paths. Multiple runs can coexist in the same directory.

CLI commands automatically select the only run in the current cwd. When several match, use `--run <id-or-unique-prefix>`. `watchdog runs` lists all active registered runs. Only an unreachable socket should be pruned; an ordinary unsupported/failed control action must not unregister a healthy runtime.

The browser reads the global registry and can switch between simultaneous projects/runs. `/` contains live/observed runs only; `/demo` contains simulations only. It never merges unrelated roots into one execution tree.

Adapter metadata drives visible `WATCHING CODEX`, `PI`, `CLAUDE CODE`, `OPENCODE`, or `DEMO` labels in Yard, Operator, and TUI. Pi/Claude/OpenCode labels are ready, but those adapters are not implemented.

## Codex facts that were actually validated

Local CLI during the initial spike: `codex-cli 0.144.4`; latest clean-terminal validation used `0.144.5`.

- A Watchdog-owned App Server receives live root/child thread events, child output/activity, status, turns, parent waits, and token updates.
- `parentThreadId` from `thread/read` is the topology source of truth. `subAgentActivity` may be emitted in a child context and point back toward the parent; do not infer edge direction from that event alone.
- Collaboration spawn records expose requested child model/reasoning/prompt. Resuming/reading the child exposes effective model/reasoning. Preserve requested-versus-effective fields separately.
- A real CLI `0.144.5` run on 2026-07-18 was explicitly given four collaboration slots **including the root**, so only three children could run concurrently. The root's fourth `spawn_agent` call failed with `collab spawn failed: agent thread limit reached`; after the operator stopped the first three, the fourth child started successfully. The user's config had no `agents.max_threads` override, so treat this as a runtime/session cap until the override path is verified.
- In that same run, a natural-language request for exactly one GPT-5.6 Luna/high child did not produce a model override. The first child correctly used `fork_turns: "none"`, but all four children were effectively `gpt-5.6-sol/xhigh`; the structured spawn call exposed no requested model/effort. This is direct evidence for Watchdog's requested-versus-effective configuration warning, not proof that natural-language model selection is reliable.
- Root `turn/steer` and interrupt work when active-turn IDs are current.
- `watchdog codex` must leave the active terminal entirely to the native Codex TUI. Streaming `[watchdog]` event lines into stderr corrupts Codex's full-screen cursor renderer. Startup metadata is printed before Codex launches; normalized events go to the JSONL trace/control surfaces and App Server output goes to a sibling `.diagnostics.log`. The Ink interface remains a separate `watchdog tui` process in another terminal.
- Native multi-agent-v2 children reject direct `turn/steer` and `turn/start` with “direct app-server input is not allowed.” Direct `turn/interrupt` works. Therefore native children are stop-only today; do not claim direct child steer/retry/model switching.
- A real sleeping child named `Cicero` was stopped via Watchdog; `parentNotified: true`, and the root stopped waiting and completed without manual follow-up.
- A 2026-07-17 live rehearsal exposed two control-plane gaps that are now fixed. Local control requests have coherent action deadlines: 5 seconds for snapshots, 25 seconds for ordinary controls, and 35 seconds for retry (whose bounded interrupt/wait/start sequence can legitimately take longer). Dashboard registry snapshots use a 2-second deadline and refreshes do not overlap; a timeout does not unregister a possibly recoverable runtime. Codex App Server RPC calls have a 10-second deadline, clear their timers on resolution, and reject every pending request immediately on unexpected connection close.
- Stop notification results are topology-truthful. For a first-level child, the root is the direct parent and `parentNotified: true` remains valid. For `root → child → grandchild`, Codex cannot accept direct steering input to the immediate native-child parent; Watchdog notifies the root, returns `rootNotified: true` and `parentNotified: false`, and tells the root that the direct parent may still be waiting. Dashboard/TUI notices preserve that distinction.
- Codex remote mode is interactive-only in this version; `codex exec --remote` is unsupported.
- A separate App Server is not a global live bus for unrelated ordinary Codex processes. External sessions become readable from `~/.codex/sessions/` but do not stream live into Watchdog’s server.
- Do not use terminal-key injection as a control mechanism.
- Codex App Server currently uses an ephemeral loopback WebSocket. Its Unix listener did not accept the prototype’s standard WebSocket client handshake. This is separate from Watchdog’s own Unix control sockets.
- `codex app-server daemon start` failed with the Bun-installed CLI because its managed standalone binary was absent; Watchdog directly owns `codex app-server --listen`.

Codex already has agent profiles, defaults, depth/thread limits, orchestration, and `/subagents`. Do not reimplement them. Watchdog adds loop semantics, cross-thread rollups, warnings, cross-harness normalization, and a concurrent control surface.

## Pi opportunity

Pi adapter is not implemented, but local Pi `0.80.7` was inspected.

- The local `pi-subagents` source launches semantic child workers as isolated Pi subprocesses and captures streaming events, tool calls/messages, model, tokens/cache/cost, timeouts, and final output.
- Its current one-shot `pi --mode json -p --no-session` workers are not individually steerable; handles remain internal.
- Pi ships typed RPC support via `pi --mode rpc`: prompt, steer, follow-up, abort, state, model, thinking level, stats, fork, and clone. An offline handshake was validated.
- Preferred future adapter: one Pi RPC client per worker (or embedded `AgentSession`), stable child IDs, normalized events, and per-child capability routing.
- Local `pi-goal` source models objective, loop status, iterations, token budgets, continuations, pause/resume/abort, and completion. If integrated, translate its authoritative state rather than duplicating it.

Normalized taxonomy must distinguish `native-child`, `subprocess-worker`, and `independent-session`; adapters own lifecycle truth and capabilities.

Claude Code and OpenCode still require focused adapter research. Do not assume Codex semantics apply.

## Dashboard rules and non-regressions

The Yard is the memorable default; Operator is the dense debugging view.

- Explicit loops are rail lines/stations; root is a locomotive; children are branch cars; verifier is a signal; tokens are fuel/load. An ordinary Codex turn is not automatically a loop.
- The full-body German shepherd mascot must remain clearly visible and pettable. Petting uses a fixed baseline, tail/head animation, and small white pixel hearts. No sound and no tooltip on the dog.
- The empty `/` route keeps the Yard and pettable confused dog but no trains; it must not regress into a generic blank card.
- Pixel world is a fixed 1100×680 canvas with contain scaling and centered letterboxing. Hit-testing inverts the same transform. Never independently stretch width and height.
- Train count is dynamic; sprite liveries are reused by role. There is no four-agent limit. Child cars alternate by stable spawn order (first above, second below, then repeat), and scale down only when either side becomes crowded.
- Train movement is semantic, not decorative pacing. The root locomotive faces right for left-to-right progress. Ordinary tasks render `START → END`, with active root work between them. Explicit loops render loop stations. Every child gets a perpendicular spur with no extra horizontal branch rail: active children remain away from the main line, and completed children move toward it while remaining inspectable.
- Smoke is a separate sprite animation. The chimney/smoke anchors in `YardCanvas.tsx` were manually tuned by the user; do not casually “clean them up.”
- Petting previously had a rare full-Yard freeze: a click could be timestamped just after the browser's current animation-frame timestamp, producing a negative pet elapsed time and sprite column `-1`. Pet elapsed/frame selection is now clamped and the next animation frame is queued before drawing. Unit coverage includes negative elapsed time and Playwright rapidly pets the dog 12 times while asserting no page error.
- Canvas cursor is normal over scenery and pointer only over interactive dog/tower/trains.
- `/demo` is isolated from real live state and is conspicuously labeled.
- `/reveal` is a runtime-independent, screenshot-ready 16:9 teaser page using the existing dog logo and `WATCHDOG` wordmark. The wordmark is live HTML text in the existing `"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace` stack; on the user's Mac it renders as SFMono-Regular. Do not imply that this is a bespoke logo font.
- Harness labels come from adapter metadata, not Codex-specific UI conditionals.
- Clicking a child carriage must open child-first details: assignment, current native activity, live response, timestamped message history, tokens/config, then any parent-loop context. Long prompts, paths, and messages must wrap inside the inspector.
- The Ink TUI is bounded to the terminal viewport and uses visible pane focus. The Run Tree is focused by default: arrows or `j/k` change the selected agent. `Tab`/Right focuses the Inspector, where arrows or `j/k` scroll one line and Page Up/Down scroll half a viewport; `Tab`/Left/Escape returns to the tree. Home/End act within the focused pane. The inspector shows every retained message newest-first (the runtime retains the newest 100), not an arbitrary three-message preview. Keep the yellow focused-pane border, visible line-range indicator, and selection-change scroll reset.
- TUI control hints come from the selected agent's live adapter capabilities and use explicit labels. Show only actions that are currently available: for example, an active Codex native child shows `x stop`, while an active Codex root shows `s steer · x stop · r retry`. Never regress to a generic `s/x/r control` hint or advertise unavailable child steering/retry.
- Requested configuration labels describe overrides, not transport availability: when no model or effort override was requested, show `no override` / `default effort`, never the ambiguous `not exposed`.
- `item/agentMessage/delta` drives a transient live-response draft. A completed `agentMessage` is deduplicated by item ID and committed once. In-memory history retains the newest 100 messages per agent plus a total count; the full completed-message stream remains in the append-only run trace. Streaming deltas are deliberately not logged one by one. Ordinary commentary is not loop evidence unless an adapter/operator emits an explicit evidence event.

Assets under `web/public/assets/` include the dog/logo sprites, train atlas, smoke, signal tower, track/cloud atlases, and backdrop. Do not regenerate or replace them without explicit need and visual comparison.

## Demo story

The reliable rehearsal is documented in `docs/demo-rehearsal.md`.

Preferred narrative:

1. Show a loop burning budget without satisfying its verifier.
2. Reveal fan-out, duplicate work, and/or a requested-effective config mismatch.
3. Stop the duplicate child and show automatic parent notification/wake-up.
4. Inspect evidence and capability limits.
5. Retry/steer the root’s next action with explicit model/effort when supported.

Never fabricate a model mismatch in the real Codex demo. The deterministic demo may illustrate the product concept but must remain labeled simulation.

## Commands and verification

```bash
bun install
bun run dev -- codex
bun run dashboard
bun run demo
bun run dev -- runs
bun run dev -- tree --run <id-prefix>
bun run dev -- tui --run <id-prefix>

bun run check
bun run test
bun run test:web
bun run build
bun pm pack --dry-run
```

Dashboard default: `http://127.0.0.1:4242`; deterministic Playwright runtimes use `4244` and `4245`.

Latest validation on 2026-07-19:

- TypeScript checks pass.
- 39 unit tests across 13 files pass.
- A real `watchdog codex` PTY launch on CLI `0.144.5` rendered the native Codex screen without interleaved Watchdog event output.
- Playwright passes two browser tests: the live dashboard with two simultaneous registered runtimes/run switching, and the `/reveal` title card at 1200×675.
- Production build passes.
- Package dry-run includes CLI chunks, built dashboard, and raster assets; unpacked package is about 8.15 MB.

The in-app browser was unavailable during the last check, so visual interaction was validated with installed Playwright and an inspected screenshot.

## Repository state

- Public repository: `https://github.com/awesamarth/watchdog`
- Branch: `main`
- Only pushed commit: `ecb4738` (`pre-demo commit`)
- Dashboard, demo, distribution, multi-run, and documentation work after that commit is currently uncommitted.
- `.watchdog/`, `.devpost-hackathon-state.json`, generated build/test output, and `docs/` are ignored. The user explicitly asked for `docs/` to remain ignored.
- Preserve the dirty tree. Never reset, discard, or overwrite unrelated changes.

## Immediate next priorities

Start a fresh session here, read this file and `README.md`, then:

1. **Manually validate two real simultaneous `watchdog codex` sessions**, the dashboard picker, and `--run` CLI targeting. Automated two-runtime coverage passes, but the new registry path has not yet been exercised with two real Codex TUIs.
2. **Polish distribution:** decide final npm package name, remove `private` only when ready, add license/metadata, verify installed `npx`/global execution under Node 22, and keep dashboard assets in the tarball. The finished README should be user-first—product promise, install, quick start, and controls—followed by source-development and architecture sections. Its required “How Codex and GPT-5.6 were used” section already exists and should remain truthful and prominent. Do not publish without explicit permission.
3. **Strengthen the loop-first proof:** make real loop objective/iteration/verifier/evidence capture less manual, improve runaway/failed-verifier warnings, and rehearse one credible live Codex prompt end to end.
4. **Add honest cost visibility:** token rollups exist; robust dollar-cost estimates and pricing provenance do not.
5. **Build the Pi adapter only after the Codex demo is dependable.** Claude Code/OpenCode follow after capability research.
6. Prepare Devpost copy/assets only when the product and live demo feel truthful and stable.

## Open questions

- Final npm package/command naming and availability.
- How Watchdog should declare or infer loop boundaries/exit criteria when a harness has no authoritative loop primitive.
- Whether `agents.max_threads` can raise the four-slot cap for a Watchdog-owned remote Codex session, and whether that setting must be applied to the App Server, the remote TUI, or both.
- How an explicit loop supervisor should provide custom station/step definitions instead of the current semantic `PLAN → EXECUTE → VERIFY → DONE` default.
- Completed subagents now move toward the main line on their perpendicular spur and remain inspectable. Decide the final retention lifecycle and add a distinct stopped-child visual instead of treating interruption like ordinary inactivity.
- Whether to offer a tiny loop SDK, local MCP tools, or both for richer explicit instrumentation.
- Whether a compatible private Unix transport can replace the Codex App Server’s ephemeral loopback WebSocket.
- Best honest dollar-cost model across harnesses/providers.
- Future supported parent-orchestrator route for steering/retrying Codex native children.
- Exact Claude Code and OpenCode event/control surfaces.
- Whether dashboard registry polling at 300 ms should become event-driven after the hackathon MVP.
