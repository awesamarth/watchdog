import { describe, expect, it } from "vitest";
import { childTrackSlots, childTrainScale, childTrainTargetX, childTrainTargetY, rootTrainTargetX, workflowStations } from "./yardMotion";

describe("rail-yard semantic motion", () => {
  it("parks active work between stations without time-based pacing", () => {
    expect(rootTrainTargetX({ phase: "execute" }, true)).toBe(412);
    expect(rootTrainTargetX({ phase: "verify" }, true)).toBe(612);
    expect(rootTrainTargetX({ phase: "done" }, false)).toBe(915);
  });

  it("moves a child only after its work completes", () => {
    expect(childTrainTargetX(700, true, "inProgress")).toBe(700);
    expect(childTrainTargetX(700, false, "completed")).toBe(712);
    expect(childTrainTargetY(272, true, "active", "inProgress")).toBe(272);
    expect(childTrainTargetY(205, false, "idle", "completed")).toBe(270);
    expect(childTrainTargetY(610, false, "idle", "completed")).toBe(535);
  });

  it("alternates stable perpendicular sidings above and below the main line", () => {
    expect(childTrackSlots(1).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 690 },
    ]);
    expect(childTrackSlots(2).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 690 },
      { side: "below", x: 690 },
    ]);
    expect(childTrackSlots(3).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 520 },
      { side: "below", x: 690 },
      { side: "above", x: 860 },
    ]);
    expect(childTrackSlots(4).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 520 },
      { side: "below", x: 520 },
      { side: "above", x: 860 },
      { side: "below", x: 860 },
    ]);
  });

  it("shrinks child cars only when a siding becomes crowded", () => {
    expect(childTrainScale(4)).toBe(1);
    expect(childTrainScale(5)).toBe(.9);
    expect(childTrainScale(9)).toBe(.7);
    expect(childTrainScale(20)).toBe(.62);
  });

  it("uses START and END for an ordinary task instead of inventing a loop", () => {
    expect(workflowStations()).toEqual([{ x: 365, label: "START" }, { x: 900, label: "END" }]);
    expect(rootTrainTargetX(undefined, true, "active")).toBe(600);
    expect(rootTrainTargetX(undefined, false, "idle")).toBe(900);
  });
});
