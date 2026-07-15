import { describe, expect, it } from "vitest";
import { childTrainTargetX, rootTrainTargetX } from "./yardMotion";

describe("rail-yard semantic motion", () => {
  it("parks active work between stations without time-based pacing", () => {
    expect(rootTrainTargetX({ phase: "execute" }, true)).toBe(412);
    expect(rootTrainTargetX({ phase: "verify" }, true)).toBe(612);
    expect(rootTrainTargetX({ phase: "done" }, false)).toBe(915);
  });

  it("moves a child only after its work completes", () => {
    expect(childTrainTargetX(700, true, "inProgress")).toBe(700);
    expect(childTrainTargetX(700, false, "completed")).toBe(742);
  });
});
