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
};

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
  comments: number;
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
