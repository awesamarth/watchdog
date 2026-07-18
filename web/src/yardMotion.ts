export type LoopPhase = "plan" | "execute" | "verify" | "done" | "blocked";
export type ChildTrackSlot = { side: "above" | "below"; x: number; y: number };

/** Semantic targets only: elapsed animation time never changes these values. */
export function rootTrainTargetX(loop: { phase: LoopPhase } | undefined, active: boolean, status = "unknown"): number {
  if (!loop) {
    if (active) return 600;
    return status === "unknown" ? 365 : 900;
  }
  if (loop.phase === "plan") return 315;
  if (loop.phase === "execute") return active ? 412 : 510;
  if (loop.phase === "verify") return active ? 612 : 715;
  if (loop.phase === "done") return 915;
  return 715;
}

export function childTrainTargetX(baseX: number, active: boolean, activityStatus?: string): number {
  return baseX + (!active && activityStatus === "completed" ? 12 : 0);
}

export function childTrainTargetY(baseY: number, active: boolean, status: string, activityStatus?: string, mainLineY = 410): number {
  const completed = !active && (activityStatus === "completed" || status === "idle" || status === "done" || status === "completed");
  if (!completed) return baseY;
  return baseY < mainLineY ? mainLineY - 140 : mainLineY + 125;
}

/**
 * Keep spawn order stable while distributing work across perpendicular
 * sidings: first child above, second below, then alternate.
 */
export function childTrackSlots(count: number): ChildTrackSlot[] {
  if (count <= 0) return [];
  const aboveCount = Math.ceil(count / 2);
  const belowCount = Math.floor(count / 2);
  const aboveX = spreadTrackXs(aboveCount);
  const belowX = spreadTrackXs(belowCount);
  let aboveIndex = 0;
  let belowIndex = 0;
  return Array.from({ length: count }, (_, index) => {
    const side = index % 2 === 0 ? "above" : "below";
    return side === "above"
      ? { side, x: aboveX[aboveIndex++]!, y: 205 }
      : { side, x: belowX[belowIndex++]!, y: 610 };
  });
}

/** Reduce only child cars once either side of the yard gets crowded. */
export function childTrainScale(count: number): number {
  const busiestSide = Math.ceil(Math.max(0, count) / 2);
  return Math.max(.62, 1 - Math.max(0, busiestSide - 2) * .1);
}

export function workflowStations(loop?: { phase: LoopPhase }): Array<{ x: number; label: string }> {
  if (!loop) return [{ x: 365, label: "START" }, { x: 900, label: "END" }];
  return [{ x: 315, label: "PLAN" }, { x: 510, label: "EXECUTE" }, { x: 715, label: "VERIFY" }, { x: 915, label: "DONE" }];
}

function spreadTrackXs(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [690];
  const start = count <= 2 ? 520 : 390;
  const end = count <= 2 ? 860 : 990;
  return Array.from({ length: count }, (_, index) => start + index * ((end - start) / (count - 1)));
}
