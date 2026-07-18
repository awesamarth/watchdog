import { describe, expect, it } from "vitest";
import { harnessDisplayName, harnessSlug } from "./harness";

describe("harness presentation", () => {
  it("normalizes current and future adapter identities without Codex-specific UI logic", () => {
    expect(harnessDisplayName({ harness: "codex", transport: "app-server", mode: "live", label: "Codex" })).toBe("CODEX");
    expect(harnessDisplayName({ harness: "pi", transport: "rpc", mode: "live", label: "Pi" })).toBe("PI");
    expect(harnessDisplayName({ harness: "claude-code", transport: "hooks", mode: "live", label: "Claude" })).toBe("CLAUDE CODE");
    expect(harnessDisplayName({ harness: "opencode", transport: "events", mode: "live", label: "OpenCode" })).toBe("OPENCODE");
    expect(harnessSlug({ harness: "claude-code", transport: "hooks", mode: "live", label: "Claude" })).toBe("claude-code");
  });
});
