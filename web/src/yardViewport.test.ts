import { describe, expect, it } from "vitest";
import { dogPetFrame, yardViewport } from "./YardCanvas";

describe("yardViewport", () => {
  it("preserves the 1100×680 world ratio in narrow canvases", () => {
    expect(yardViewport(550, 680)).toEqual({ scale: .5, x: 0, y: 170 });
  });

  it("preserves the world ratio in short canvases", () => {
    expect(yardViewport(1100, 340)).toEqual({ scale: .5, x: 275, y: 0 });
  });

  it("fills a matching aspect ratio without letterboxing", () => {
    expect(yardViewport(550, 340)).toEqual({ scale: .5, x: 0, y: 0 });
  });
});

describe("dogPetFrame", () => {
  it("never selects an invalid sprite column when frame time precedes the click timestamp", () => {
    expect(dogPetFrame(-.01)).toBe(0);
    expect(dogPetFrame(0)).toBe(0);
    expect(dogPetFrame(.89)).toBe(3);
  });
});
