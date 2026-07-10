export type Viewer = {
  login: string;
  avatarUrl: string;
};

export type Stream = {
  id: number;
  name: string;
  query: string;
  folder: string | null;
  intervalSec: number;
  enabled: boolean;
  position: number;
  unreadCount: number;
  totalCount: number;
  color: string | null; // hex without '#', e.g. "6366f1"
};

// Shared preset palette for stream/folder color pickers. Hex without '#'.
export const COLOR_PALETTE: string[] = [
  "e11d48",
  "ea580c",
  "ca8a04",
  "16a34a",
  "0d9488",
  "0284c7",
  "6366f1",
  "9333ea",
  "db2777",
  "64748b",
];

export type Item = {
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  author: string | null;
  authorAvatar: string | null;
  repo: string;
  milestone: string | null;
  comments: number;
  assignees: string[];
  epicIds: number[];
  isRead: boolean;
};

export type LabelInfo = { name: string; color: string }; // color = hex without '#', e.g. "d73a4a"

export type CommentInfo = {
  author: string | null;
  authorAvatar: string | null;
  bodyHtml: string; // GitHub-rendered, pre-sanitized HTML
  createdAt: string; // ISO8601
};

// status values: SUCCESS | FAILURE | ERROR | PENDING | IN_PROGRESS | QUEUED | EXPECTED | NEUTRAL
//              | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE
export type CheckInfo = { name: string; status: string; url: string | null };

// state: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
export type ReviewInfo = { author: string | null; state: string };

// Development リンク(Issue⇔PR)。Issue 詳細では関連 PR、PR 詳細では関連 Issue が入る
export type RelatedItem = {
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  repo: string; // "owner/name"
};

export type ItemDetail = {
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  bodyHtml: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  authorAvatar: string | null;
  repo: string; // "owner/name"
  labels: LabelInfo[];
  assignees: string[]; // logins
  milestone: string | null;
  // PR-only fields; for issues: null / 0 / empty arrays
  baseRef: string | null;
  headRef: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string | null; // MERGEABLE | CONFLICTING | UNKNOWN
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  checks: CheckInfo[];
  reviews: ReviewInfo[]; // latest review per reviewer
  comments: CommentInfo[]; // last 30, chronological
  commentsTotal: number;
  related: RelatedItem[]; // first 10 Development links
  relatedTotal: number;
};

export type MergeMethod = "merge" | "squash" | "rebase";
export type ReviewVerdict = "approve" | "requestChanges" | "comment";

export type ItemAction =
  | { type: "comment"; body: string }
  | { type: "close" }
  | { type: "reopen" }
  | { type: "merge"; method: MergeMethod; deleteBranch: boolean }
  | { type: "review"; verdict: ReviewVerdict; body: string | null }
  | { type: "ready"; undo: boolean } // undo=true → convert back to draft
  | { type: "updateBranch" }
  | { type: "editLabels"; add: string[]; remove: string[] }
  | { type: "assignMe"; remove: boolean };

export type UpdateInfo = {
  current: string;
  latest: string;
  url: string;
  method: "brew" | "updater";
};

export type GraphPr = { number: number; title: string; url: string };
export type GraphBranch = {
  name: string;
  tipOid: string;
  isDefault: boolean;
  ahead: number; // commits this branch is ahead of the default branch
  behind: number; // commits behind the default branch
  pr: GraphPr | null; // open PR whose head is this branch, if any
};
export type GraphCommit = {
  oid: string;
  shortOid: string;
  message: string; // headline only
  author: string | null;
  authorAvatar: string | null;
  date: string; // ISO8601
  lane: number; // 0-based lane index, precomputed by backend
  parents: string[]; // parent oids; may reference commits NOT present in `commits` (history cutoff)
  branchTips: string[]; // branch names whose tip is this commit
  url: string; // commit page on github.com
};
export type BranchGraph = {
  repo: string;
  defaultBranch: string;
  branches: GraphBranch[]; // default branch first, then by tip date desc
  commits: GraphCommit[]; // DISPLAY ORDER: topological, newest first — children always appear before their parents
  laneCount: number;
};

export type Epic = {
  id: number;
  name: string;
  note: string | null;
  color: string | null; // hex without '#', same palette as streams (COLOR_PALETTE)
  position: number;
  archived: boolean;
  itemCount: number;
  doneCount: number; // state CLOSED or MERGED
};
export type EpicItem = Item & { epicPosition: number };
export type EpicSuggestion = { milestone: string; repo: string; count: number };
