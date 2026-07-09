import { describe, expect, it } from "vitest";
import { buildQuery, joinQuerySets, parseQuery, splitQuerySets } from "./StreamModal";

const base = () => parseQuery("");

describe("buildQuery", () => {
  it("composes tokens in the documented order", () => {
    const q = buildQuery({
      ...base(),
      kind: "pr",
      status: "open",
      relations: ["involves", "review-requested"],
      repos: ["Love-Rox/Harushion", "tauri-apps/tauri"],
      org: "Love-Rox",
      labels: ["bug", "help wanted"],
      excludeDraft: true,
      sort: "updated-desc",
      rest: "no:assignee",
    });
    expect(q).toBe(
      'is:pr is:open involves:@me review-requested:@me repo:Love-Rox/Harushion repo:tauri-apps/tauri org:Love-Rox label:"bug" label:"help wanted" -is:draft no:assignee sort:updated-desc',
    );
  });

  it("omits empty fields entirely", () => {
    expect(buildQuery({ ...base(), sort: "" })).toBe("");
  });
});

describe("parseQuery", () => {
  it("returns empty defaults for an empty query", () => {
    const s = parseQuery("");
    expect(s.kind).toBe("");
    expect(s.relations).toEqual([]);
    expect(s.repos).toEqual([]);
    expect(s.rest).toBe("");
  });

  it("keeps quoted labels with spaces as one token", () => {
    const s = parseQuery('label:"help wanted" label:bug');
    expect(s.labels).toEqual(["help wanted", "bug"]);
  });

  it("preserves unknown tokens in rest without loss", () => {
    const s = parseQuery("is:pr milestone:v1 no:assignee is:draft");
    expect(s.kind).toBe("pr");
    // -is:draft のみ認識対象。素の is:draft は未知トークンとして rest へ
    expect(s.rest).toBe("milestone:v1 no:assignee is:draft");
  });

  it("sends unsupported sort values to rest", () => {
    const s = parseQuery("sort:reactions-desc");
    expect(s.sort).toBe("");
    expect(s.rest).toBe("sort:reactions-desc");
  });

  it("dedupes repeated relations", () => {
    const s = parseQuery("involves:@me involves:@me");
    expect(s.relations).toEqual(["involves"]);
  });

  it("round-trips through buildQuery losslessly", () => {
    const state = parseQuery(
      'is:issue is:closed author:@me repo:o/r label:"wip" -is:draft in:title sort:created-desc',
    );
    expect(parseQuery(buildQuery(state))).toEqual(state);
    // rest(未知トークン)も含めて保持されている
    expect(state.rest).toBe("in:title");
    expect(state.excludeDraft).toBe(true);
  });
});

describe("splitQuerySets", () => {
  it("ignores empty lines and trims each line", () => {
    expect(splitQuerySets("involves:@me\n\n  repo:o/r is:pr  \n")).toEqual([
      "involves:@me",
      "repo:o/r is:pr",
    ]);
  });

  it("returns an empty array for a blank string", () => {
    expect(splitQuerySets("   \n\n")).toEqual([]);
  });
});

describe("joinQuerySets", () => {
  it("round-trips with splitQuerySets", () => {
    const sets = ["involves:@me", "repo:o/r is:pr"];
    expect(splitQuerySets(joinQuerySets(sets))).toEqual(sets);
  });

  it("trims each set and drops empty ones when joining", () => {
    expect(joinQuerySets(["  involves:@me  ", "", "  "])).toBe("involves:@me");
  });
});
