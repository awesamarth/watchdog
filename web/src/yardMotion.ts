export type LoopPhase = "plan" | "execute" | "verify" | "done" | "blocked";

/** Semantic targets only: elapsed animation time never changes these values. */
export function rootTrainTargetX(loop: { phase: LoopPhase } | undefined, active: boolean): number {
  if (!loop) return active ? 412 : 510;
  if (loop.phase === "plan") return 315;
  if (loop.phase === "execute") return active ? 412 : 510;
  if (loop.phase === "verify") return active ? 612 : 715;
  if (loop.phase === "done") return 915;
  return 715;
}

export function childTrainTargetX(baseX: number, active: boolean, activityStatus?: string): number {
  return baseX + (!active && activityStatus === "completed" ? 42 : 0);
}
