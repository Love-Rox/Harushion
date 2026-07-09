import { describe, expect, it } from "vitest";
import { resolveState } from "./StateBadge";

describe("resolveState", () => {
  it.each([
    ["pr", "MERGED", false, "Merged", "state-merged"],
    ["pr", "CLOSED", false, "Closed", "state-closed"],
    ["pr", "OPEN", true, "Draft", "state-draft"],
    ["pr", "OPEN", false, "Open", "state-open"],
    ["issue", "OPEN", false, "Open", "state-open"],
    // Issue の Closed は GitHub 本家に合わせて紫(state-done)
    ["issue", "CLOSED", false, "Closed", "state-done"],
  ] as const)("%s/%s(draft=%s) → %s (%s)", (kind, state, isDraft, label, color) => {
    const resolved = resolveState(kind, state, isDraft);
    expect(resolved.label).toBe(label);
    expect(resolved.color).toBe(color);
    expect(resolved.icon.length).toBeGreaterThan(0);
  });

  it("merged wins over draft flag", () => {
    expect(resolveState("pr", "MERGED", true).label).toBe("Merged");
  });
});
