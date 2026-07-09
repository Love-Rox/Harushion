import { useMemo } from "react";
import type { BranchGraph, GraphBranch, GraphCommit } from "../types";
import { relativeTime } from "./format";
import { useI18n } from "../i18n";
import type { TFunction } from "../i18n";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const RAIL_PADDING = 14;

// 8 fixed lane hues, mid-saturation so they read on both light and dark backgrounds.
export const LANE_COLORS = [
  "#4c9aff", // blue
  "#57ab5a", // green
  "#e8863c", // orange
  "#c678dd", // violet
  "#e5534b", // red
  "#39c5cf", // cyan
  "#d4a72c", // amber
  "#f778ba", // pink
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

type Props = {
  repo: string;
  data: BranchGraph | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenInApp: (url: string) => void;
};

export function GraphView({ repo, data, loading, error, onRefresh, onOpenInApp }: Props) {
  const { t } = useI18n();
  return (
    <div className="graph-view">
      <header className="header graph-header">
        <div className="header-title">
          <h1 className="app-title">{repo}</h1>
          {data && (
            <code className="query">
              {t("graph.defaultBranch", { branch: data.defaultBranch })}
            </code>
          )}
        </div>
        <div className="header-right">
          <button className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? t("common.updating") : t("common.refresh")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onOpenInApp(`https://github.com/${repo}`)}
          >
            {t("graph.openInGithub")}
          </button>
        </div>
      </header>

      <main className="graph-body">
        {error && (
          <div className="error">
            <p>{error}</p>
            <button className="btn" onClick={onRefresh}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {!error && !data && loading && (
          <div className="graph-loading">
            <div className="spinner" />
          </div>
        )}
        {!error && data && (
          <>
            {loading && <div className="detail-loading-bar" />}
            <BranchStrip branches={data.branches} onOpenInApp={onOpenInApp} t={t} />
            {data.commits.length === 0 ? (
              <p className="empty">{t("graph.noCommits")}</p>
            ) : (
              <CommitGraph
                commits={data.commits}
                branches={data.branches}
                laneCount={data.laneCount}
                onOpenInApp={onOpenInApp}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function branchDiffLabel(t: TFunction, branch: GraphBranch): string {
  if (branch.ahead === 0 && branch.behind === 0) return t("graph.latest");
  const parts: string[] = [];
  if (branch.ahead > 0) parts.push(`↑${branch.ahead}`);
  if (branch.behind > 0) parts.push(`↓${branch.behind}`);
  return parts.join(" ");
}

function BranchStrip({
  branches,
  onOpenInApp,
  t,
}: {
  branches: GraphBranch[];
  onOpenInApp: (url: string) => void;
  t: TFunction;
}) {
  return (
    <div className="branch-strip">
      {branches.map((b) => (
        <span key={b.name} className={`branch-chip${b.isDefault ? " branch-chip-default" : ""}`}>
          <span className="branch-chip-name">{b.name}</span>
          {!b.isDefault && <span className="branch-chip-diff">{branchDiffLabel(t, b)}</span>}
          {b.pr && (
            <button
              className="branch-chip-pr"
              title={b.pr.title}
              onClick={() => onOpenInApp(b.pr!.url)}
            >
              #{b.pr.number}
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function CommitGraph({
  commits,
  branches,
  laneCount,
  onOpenInApp,
}: {
  commits: GraphCommit[];
  branches: GraphBranch[];
  laneCount: number;
  onOpenInApp: (url: string) => void;
}) {
  const railWidth = Math.max(laneCount * LANE_WIDTH + RAIL_PADDING, 28);
  const height = commits.length * ROW_HEIGHT;

  const indexByOid = useMemo(() => {
    const map = new Map<string, number>();
    commits.forEach((c, i) => map.set(c.oid, i));
    return map;
  }, [commits]);

  const prByBranchName = useMemo(() => {
    const map = new Map<string, GraphBranch>();
    for (const b of branches) {
      if (b.pr) map.set(b.name, b);
    }
    return map;
  }, [branches]);

  const dotX = (lane: number) => 7 + lane * LANE_WIDTH;
  const dotY = (index: number) => index * ROW_HEIGHT + 14;

  const paths: { d: string; color: string; key: string }[] = [];
  const dots: { cx: number; cy: number; color: string; key: string }[] = [];
  const stubs: { x: number; y: number; color: string; key: string }[] = [];

  commits.forEach((c, i) => {
    const cx = dotX(c.lane);
    const cy = dotY(i);
    dots.push({ cx, cy, color: laneColor(c.lane), key: c.oid });

    let hasMissingParent = false;
    c.parents.forEach((parentOid, parentIndex) => {
      const pi = indexByOid.get(parentOid);
      if (pi === undefined) {
        hasMissingParent = true;
        return;
      }
      const parent = commits[pi];
      const px = dotX(parent.lane);
      const py = dotY(pi);
      const d =
        parent.lane === c.lane
          ? `M ${cx} ${cy} L ${px} ${py}`
          : `M ${cx} ${cy} C ${cx} ${(cy + py) / 2}, ${px} ${(cy + py) / 2}, ${px} ${py}`;
      // 第1親へのエッジは子のブランチ線の続きなので子のレーン色、
      // 第2親以降(マージで合流してくる線)は親側のレーン色で塗る
      const lane = parentIndex === 0 ? c.lane : parent.lane;
      paths.push({ d, color: laneColor(lane), key: `${c.oid}-${parentOid}` });
    });
    if (hasMissingParent) {
      stubs.push({ x: cx, y: cy, color: laneColor(c.lane), key: `${c.oid}-stub` });
    }
  });

  return (
    <div className="commit-graph">
      <svg className="commit-rail" width={railWidth} height={height}>
        {paths.map((p) => (
          <path key={p.key} d={p.d} stroke={p.color} strokeWidth={2} fill="none" />
        ))}
        {stubs.map((s) => (
          <line
            key={s.key}
            x1={s.x}
            y1={s.y}
            x2={s.x}
            y2={s.y + 10}
            stroke={s.color}
            strokeWidth={2}
            opacity={0.35}
          />
        ))}
        {dots.map((d) => (
          <circle key={d.key} cx={d.cx} cy={d.cy} r={4} fill={d.color} />
        ))}
      </svg>
      <div className="commit-rows">
        {commits.map((c) => (
          <div className="commit-row" key={c.oid}>
            <button className="commit-message" title={c.message} onClick={() => onOpenInApp(c.url)}>
              {c.message}
            </button>
            {c.branchTips.length > 0 && (
              <span className="commit-tips">
                {c.branchTips.map((tip) => {
                  const branch = prByBranchName.get(tip);
                  return (
                    <span className="commit-tip-group" key={tip}>
                      <span
                        className="branch-tip-chip"
                        style={{ borderColor: laneColor(c.lane), color: laneColor(c.lane) }}
                      >
                        {tip}
                      </span>
                      {branch?.pr && (
                        <button
                          className="commit-pr-chip"
                          title={branch.pr.title}
                          onClick={() => onOpenInApp(branch.pr!.url)}
                        >
                          #{branch.pr.number}
                        </button>
                      )}
                    </span>
                  );
                })}
              </span>
            )}
            <span className="commit-oid">{c.shortOid}</span>
            <span className="commit-author">{c.author ?? "unknown"}</span>
            <span className="commit-time">{relativeTime(c.date)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
