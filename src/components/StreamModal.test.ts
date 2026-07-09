import { describe, expect, it } from "vitest";
import {
  buildQuery,
  computeGroups,
  expandBuilderToSets,
  foldOrGroup,
  joinQuerySets,
  parseQuery,
  splitQuerySets,
} from "./StreamModal";

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

describe("expandBuilderToSets", () => {
  it("returns a single line in and mode, even with 2+ relations", () => {
    const state: ReturnType<typeof parseQuery> = {
      ...base(),
      relationsMode: "and",
      relations: ["author", "assignee"],
    };
    expect(expandBuilderToSets(state)).toEqual([buildQuery(state)]);
  });

  it("returns a single line in or mode with ≤1 relation (and/or are equivalent)", () => {
    const zero: ReturnType<typeof parseQuery> = { ...base(), relationsMode: "or", relations: [] };
    const one: ReturnType<typeof parseQuery> = {
      ...base(),
      relationsMode: "or",
      relations: ["author"],
    };
    expect(expandBuilderToSets(zero)).toEqual([buildQuery(zero)]);
    expect(expandBuilderToSets(one)).toEqual([buildQuery(one)]);
  });

  it("returns one line per relation in or mode with 2+ relations, all other tokens identical", () => {
    const state: ReturnType<typeof parseQuery> = {
      ...base(),
      relationsMode: "or",
      relations: ["author", "assignee", "mentions"],
      repos: ["o/r"],
      sort: "updated-desc",
    };
    const lines = expandBuilderToSets(state);
    expect(lines).toEqual([
      "author:@me repo:o/r sort:updated-desc",
      "assignee:@me repo:o/r sort:updated-desc",
      "mentions:@me repo:o/r sort:updated-desc",
    ]);
    // 各行の関係トークンはちょうど1つ
    for (const line of lines) {
      expect(parseQuery(line).relations).toHaveLength(1);
    }
  });
});

describe("foldOrGroup", () => {
  it("folds a valid or-group into a single or-mode builder state", () => {
    const lines = ["author:@me repo:o/r", "assignee:@me repo:o/r"];
    const folded = foldOrGroup(lines);
    expect(folded).not.toBeNull();
    expect(folded?.state.relationsMode).toBe("or");
    expect(folded?.state.relations).toEqual(["author", "assignee"]);
    expect(folded?.state.repos).toEqual(["o/r"]);
  });

  it("rejects lines that differ beyond the relation token", () => {
    expect(foldOrGroup(["author:@me repo:o/r", "assignee:@me repo:other/repo"])).toBeNull();
  });

  it("rejects duplicate relations", () => {
    expect(foldOrGroup(["author:@me repo:o/r", "author:@me repo:o/r"])).toBeNull();
  });

  it("rejects a single line (nothing to fold)", () => {
    expect(foldOrGroup(["author:@me"])).toBeNull();
  });

  it("rejects lines where any line has zero or 2+ relations", () => {
    expect(foldOrGroup(["repo:o/r", "assignee:@me repo:o/r"])).toBeNull();
    expect(foldOrGroup(["author:@me assignee:@me", "mentions:@me"])).toBeNull();
  });

  it("round-trips with expandBuilderToSets", () => {
    const state: ReturnType<typeof parseQuery> = {
      ...base(),
      kind: "pr",
      relationsMode: "or",
      relations: ["author", "assignee", "review-requested"],
      repos: ["o/r"],
      labels: ["bug"],
      sort: "updated-desc",
    };
    const lines = expandBuilderToSets(state);
    const folded = foldOrGroup(lines);
    expect(folded?.state).toEqual(state);
  });
});

describe("computeGroups", () => {
  it("keeps unrelated lines as their own single-line groups", () => {
    const sets = ["involves:@me", "repo:o/r is:pr"];
    const groups = computeGroups(sets);
    expect(groups).toHaveLength(2);
    expect(groups[0].lines).toEqual(["involves:@me"]);
    expect(groups[1].lines).toEqual(["repo:o/r is:pr"]);
  });

  it("folds an adjacent or-group into one group and leaves the rest separate", () => {
    const sets = ["author:@me repo:o/r", "assignee:@me repo:o/r", "involves:@me"];
    const groups = computeGroups(sets);
    expect(groups).toHaveLength(2);
    expect(groups[0].lines).toEqual(["author:@me repo:o/r", "assignee:@me repo:o/r"]);
    expect(groups[0].state.relationsMode).toBe("or");
    expect(groups[0].start).toBe(0);
    expect(groups[1].lines).toEqual(["involves:@me"]);
    expect(groups[1].start).toBe(2);
  });
});
