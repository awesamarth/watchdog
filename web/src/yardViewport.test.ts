import { describe, expect, it } from "vitest";
import { dogPetFrame, yardViewport } from "./YardCanvas";

describe("yardViewport", () => {
  it.each([
    ["narrow", 550, 680, { scale: .5, x: 0, y: 170 }],
    ["short", 1100, 340, { scale: .5, x: 275, y: 0 }],
    ["matching ratio", 550, 340, { scale: .5, x: 0, y: 0 }],
  ] as const)("preserves the world ratio in a %s canvas", (_label, width, height, expected) => {
    expect(yardViewport(width, height)).toEqual(expected);
  });
});

describe("dogPetFrame", () => {
  it("never selects an invalid sprite column when frame time precedes the click timestamp", () => {
    expect(dogPetFrame(-.01)).toBe(0);
    expect(dogPetFrame(0)).toBe(0);
    expect(dogPetFrame(.89)).toBe(3);
  });
});
