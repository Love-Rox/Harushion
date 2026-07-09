export type Viewer = {
  login: string;
  avatarUrl: string;
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
};
