import { describe, expect, it } from "vitest";
import { browserOpenCommand } from "./dashboard.js";

describe("dashboard browser launch", () => {
  const url = "http://127.0.0.1:4242";

  it("uses the native macOS opener", () => {
    expect(browserOpenCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
  });

  it("uses the native Windows opener", () => {
    expect(browserOpenCommand(url, "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", url] });
  });

  it("uses xdg-open on Linux", () => {
    expect(browserOpenCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });
});
