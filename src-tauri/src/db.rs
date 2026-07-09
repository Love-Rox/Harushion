use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::github::Item;

pub struct Db(Mutex<Connection>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub folder: Option<String>,
    pub interval_sec: i64,
    pub enabled: bool,
    pub position: i64,
    pub color: Option<String>,
    pub unread_count: i64,
    pub total_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub updated_at: String,
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub repo: String,
    pub comments: i64,
    pub milestone: Option<String>,
    pub assignees: Vec<String>,
    pub epic_ids: Vec<i64>,
    pub is_read: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Epic {
    pub id: i64,
    pub name: String,
    pub note: Option<String>,
    pub color: Option<String>,
    pub position: i64,
    pub archived: bool,
    pub item_count: i64,
    pub done_count: i64,
}

/// エピック内アイテム(Item 形状 + リリース順)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicRow {
    #[serde(flatten)]
    pub item: StoredItem,
    pub epic_position: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicSuggestion {
    pub milestone: String,
    pub repo: String,
    pub count: i64,
}

/// ポーリング対象の Stream。first_poll のときは通知を抑制する。
pub struct DueStream {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub first_poll: bool,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  folder TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  author TEXT,
  author_avatar TEXT,
  repo TEXT NOT NULL,
  comments INTEGER NOT NULL DEFAULT 0,
  milestone TEXT,
  assignees TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stream_items (
  stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  item_url TEXT NOT NULL REFERENCES items(url) ON DELETE CASCADE,
  PRIMARY KEY (stream_id, item_url)
);

CREATE TABLE IF NOT EXISTS read_state (
  item_url TEXT PRIMARY KEY REFERENCES items(url) ON DELETE CASCADE,
  last_read_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at DESC);

CREATE TABLE IF NOT EXISTS graph_repos (
  repo TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folder_colors (
  folder TEXT PRIMARY KEY,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_order (
  folder TEXT PRIMARY KEY,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS epic_items (
  epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  item_url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (epic_id, item_url)
);
"#;

// 既読判定: read_state があり、既読にした時点の updated_at 以降更新されていないこと
const IS_READ_EXPR: &str =
    "(r.last_read_updated_at IS NOT NULL AND r.last_read_updated_at >= i.updated_at)";

fn db_err(e: rusqlite::Error) -> String {
    format!("データベースエラー: {e}")
}

/// 検索クエリのうち、保存済みアイテムの列だけでローカル判定できる条件。
/// GitHub 検索は「合致しなくなったアイテム」を教えてくれないため、状態が変わった
/// アイテム(マージ済み等)を Stream から外す掃除にこの判定を使う。
#[derive(Debug, Default, PartialEq)]
pub struct LocalFilters {
    kind: Option<String>,  // "issue" | "pr"
    state: Option<String>, // "open" | "closed" | "merged" | "unmerged"
    exclude_draft: bool,
    repos: Vec<String>, // 小文字。複数は OR
    orgs: Vec<String>,  // 小文字。複数は OR
}

pub fn parse_local_filters(query: &str) -> LocalFilters {
    let mut f = LocalFilters::default();
    for token in query.split_whitespace() {
        let t = token.to_lowercase();
        match t.as_str() {
            "is:issue" | "type:issue" => f.kind = Some("issue".into()),
            "is:pr" | "type:pr" => f.kind = Some("pr".into()),
            "is:open" | "state:open" => f.state = Some("open".into()),
            "is:closed" | "state:closed" => f.state = Some("closed".into()),
            "is:merged" => f.state = Some("merged".into()),
            "is:unmerged" => f.state = Some("unmerged".into()),
            "-is:draft" => f.exclude_draft = true,
            _ => {
                if let Some(r) = t.strip_prefix("repo:") {
                    f.repos.push(r.to_string());
                } else if let Some(o) = t.strip_prefix("org:").or_else(|| t.strip_prefix("user:")) {
                    f.orgs.push(o.to_string());
                }
            }
        }
    }
    f
}

impl LocalFilters {
    /// アイテムがこの条件に「確実に違反」しているか。判定できない条件は違反にしない。
    fn violates(&self, kind: &str, state: &str, is_draft: bool, repo: &str) -> bool {
        if let Some(k) = &self.kind {
            if k != kind {
                return true;
            }
        }
        if let Some(s) = &self.state {
            let ok = match s.as_str() {
                "open" => state == "OPEN",
                // GitHub の is:closed はマージ済み PR を含む
                "closed" => state == "CLOSED" || state == "MERGED",
                "merged" => state == "MERGED",
                "unmerged" => state != "MERGED",
                _ => true,
            };
            if !ok {
                return true;
            }
        }
        if self.exclude_draft && is_draft {
            return true;
        }
        let repo_lc = repo.to_lowercase();
        if !self.repos.is_empty() && !self.repos.contains(&repo_lc) {
            return true;
        }
        if !self.orgs.is_empty() && !self.orgs.iter().any(|o| repo_lc.starts_with(&format!("{o}/"))) {
            return true;
        }
        false
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(db_err)?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(db_err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(db_err)?;
        conn.execute_batch(SCHEMA).map_err(db_err)?;

        // 既存 DB へのカラム追加移行(すでに存在する場合のエラーは無視)
        let _ = conn.execute("ALTER TABLE streams ADD COLUMN color TEXT", []);
        let _ = conn.execute("ALTER TABLE items ADD COLUMN milestone TEXT", []);
        let _ = conn.execute("ALTER TABLE items ADD COLUMN assignees TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE epics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []);

        // 初回起動時のシード Stream
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM streams", [], |r| r.get(0))
            .map_err(db_err)?;
        if count == 0 {
            conn.execute(
                "INSERT INTO streams (name, query, folder, interval_sec) VALUES (?1, ?2, NULL, 120)",
                params!["Involved", "involves:@me sort:updated-desc"],
            )
            .map_err(db_err)?;
        }
        Ok(Self(Mutex::new(conn)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().expect("db mutex poisoned")
    }

    pub fn list_streams(&self) -> Result<Vec<Stream>, String> {
        let conn = self.lock();
        let sql = format!(
            "SELECT s.id, s.name, s.query, s.folder, s.interval_sec, s.enabled, s.position, s.color,
               (SELECT COUNT(*) FROM stream_items si
                  JOIN items i ON i.url = si.item_url
                  LEFT JOIN read_state r ON r.item_url = i.url
                WHERE si.stream_id = s.id AND NOT {IS_READ_EXPR}),
               (SELECT COUNT(*) FROM stream_items si WHERE si.stream_id = s.id)
             FROM streams s ORDER BY s.position, s.id"
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map([], row_to_stream)
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn get_stream(&self, id: i64) -> Result<Stream, String> {
        let conn = self.lock();
        let sql = format!(
            "SELECT s.id, s.name, s.query, s.folder, s.interval_sec, s.enabled, s.position, s.color,
               (SELECT COUNT(*) FROM stream_items si
                  JOIN items i ON i.url = si.item_url
                  LEFT JOIN read_state r ON r.item_url = i.url
                WHERE si.stream_id = s.id AND NOT {IS_READ_EXPR}),
               (SELECT COUNT(*) FROM stream_items si WHERE si.stream_id = s.id)
             FROM streams s WHERE s.id = ?1"
        );
        conn.query_row(&sql, params![id], row_to_stream).map_err(db_err)
    }

    pub fn create_stream(
        &self,
        name: &str,
        query: &str,
        folder: Option<&str>,
        interval_sec: i64,
        color: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO streams (name, query, folder, interval_sec, color, position)
             VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position) + 1, 0) FROM streams))",
            params![name, query, folder, interval_sec.max(60), color],
        )
        .map_err(db_err)?;
        Ok(conn.last_insert_rowid())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_stream(
        &self,
        id: i64,
        name: &str,
        query: &str,
        folder: Option<&str>,
        interval_sec: i64,
        enabled: bool,
        color: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.lock();
        // クエリが変わったら次の tick で即再取得されるよう last_polled_at をリセット
        conn.execute(
            "UPDATE streams SET name = ?2, query = ?3, folder = ?4, interval_sec = ?5, enabled = ?6,
               color = ?7,
               last_polled_at = CASE WHEN query = ?3 THEN last_polled_at ELSE NULL END
             WHERE id = ?1",
            params![id, name, query, folder, interval_sec.max(60), enabled, color],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn delete_stream(&self, id: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM streams WHERE id = ?1", params![id])
            .map_err(db_err)?;
        // どの Stream・Epic からも参照されなくなったアイテムを掃除(read_state は FK CASCADE)
        conn.execute(
            "DELETE FROM items WHERE url NOT IN (SELECT item_url FROM stream_items)
               AND url NOT IN (SELECT item_url FROM epic_items)",
            [],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn list_items(&self, stream_id: i64, unread_only: bool) -> Result<Vec<StoredItem>, String> {
        let conn = self.lock();
        let sql = format!(
            "SELECT i.kind, i.number, i.title, i.url, i.state, i.is_draft, i.updated_at,
                    i.author, i.author_avatar, i.repo, i.comments, i.milestone, i.assignees,
                    (SELECT GROUP_CONCAT(ei.epic_id) FROM epic_items ei WHERE ei.item_url = i.url), {IS_READ_EXPR}
             FROM items i
             JOIN stream_items si ON si.item_url = i.url
             LEFT JOIN read_state r ON r.item_url = i.url
             WHERE si.stream_id = ?1 AND (?2 = 0 OR NOT {IS_READ_EXPR})
             ORDER BY i.updated_at DESC
             LIMIT 500"
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(params![stream_id, unread_only], |row| {
                Ok(StoredItem {
                    kind: row.get(0)?,
                    number: row.get(1)?,
                    title: row.get(2)?,
                    url: row.get(3)?,
                    state: row.get(4)?,
                    is_draft: row.get(5)?,
                    updated_at: row.get(6)?,
                    author: row.get(7)?,
                    author_avatar: row.get(8)?,
                    repo: row.get(9)?,
                    comments: row.get(10)?,
                    milestone: row.get(11)?,
                    assignees: split_assignees(row.get::<_, String>(12)?),
                    epic_ids: split_epic_ids(row.get::<_, Option<String>>(13)?),
                    is_read: row.get(14)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    /// アイテムを upsert して Stream に紐付け、「新規または更新されたアイテム」のタイトルを返す。
    pub fn upsert_items(&self, stream_id: i64, items: &[Item]) -> Result<Vec<String>, String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        let mut fresh = Vec::new();
        for item in items {
            let old_updated_at: Option<String> = tx
                .query_row(
                    "SELECT updated_at FROM items WHERE url = ?1",
                    params![item.url],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(db_err)?;

            tx.execute(
                "INSERT INTO items (url, kind, number, title, state, is_draft, updated_at,
                                    author, author_avatar, repo, comments, milestone, assignees)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(url) DO UPDATE SET
                   kind = excluded.kind, number = excluded.number, title = excluded.title,
                   state = excluded.state, is_draft = excluded.is_draft,
                   updated_at = excluded.updated_at, author = excluded.author,
                   author_avatar = excluded.author_avatar, repo = excluded.repo,
                   comments = excluded.comments, milestone = excluded.milestone,
                   assignees = excluded.assignees",
                params![
                    item.url,
                    item.kind,
                    item.number,
                    item.title,
                    item.state,
                    item.is_draft,
                    item.updated_at,
                    item.author,
                    item.author_avatar,
                    item.repo,
                    item.comments,
                    item.milestone,
                    item.assignees.join(",")
                ],
            )
            .map_err(db_err)?;

            tx.execute(
                "INSERT OR IGNORE INTO stream_items (stream_id, item_url) VALUES (?1, ?2)",
                params![stream_id, item.url],
            )
            .map_err(db_err)?;

            // ISO8601(同一フォーマット)なので文字列比較で新旧判定できる
            let is_fresh = match &old_updated_at {
                None => true,
                Some(old) => item.updated_at > *old,
            };
            if is_fresh {
                fresh.push(item.title.clone());
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(fresh)
    }

    pub fn mark_read(&self, item_url: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO read_state (item_url, last_read_updated_at)
             SELECT url, updated_at FROM items WHERE url = ?1
             ON CONFLICT(item_url) DO UPDATE SET last_read_updated_at = excluded.last_read_updated_at",
            params![item_url],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn mark_unread(&self, item_url: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM read_state WHERE item_url = ?1", params![item_url])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn mark_all_read(&self, stream_id: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO read_state (item_url, last_read_updated_at)
             SELECT i.url, i.updated_at FROM items i
             JOIN stream_items si ON si.item_url = i.url
             WHERE si.stream_id = ?1
             ON CONFLICT(item_url) DO UPDATE SET last_read_updated_at = excluded.last_read_updated_at",
            params![stream_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn due_streams(&self, now: i64) -> Result<Vec<DueStream>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, query, last_polled_at IS NULL FROM streams
                 WHERE enabled = 1
                   AND (last_polled_at IS NULL OR last_polled_at + interval_sec <= ?1)",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![now], |row| {
                Ok(DueStream {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    first_poll: row.get(3)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn get_due_stream(&self, id: i64) -> Result<DueStream, String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, name, query, last_polled_at IS NULL FROM streams WHERE id = ?1",
            params![id],
            |row| {
                Ok(DueStream {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    first_poll: row.get(3)?,
                })
            },
        )
        .map_err(db_err)
    }

    /// 表示順(配列の並び)どおりに position を振り直す
    pub fn reorder_streams(&self, ids: &[i64]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        for (position, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE streams SET position = ?2 WHERE id = ?1",
                params![id, position as i64],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn list_folder_order(&self) -> Result<Vec<String>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT folder FROM folder_order ORDER BY position")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    /// フォルダの表示順を丸ごと置き換える
    pub fn reorder_folders(&self, folders: &[String]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute("DELETE FROM folder_order", []).map_err(db_err)?;
        for (position, folder) in folders.iter().enumerate() {
            tx.execute(
                "INSERT INTO folder_order (folder, position) VALUES (?1, ?2)",
                params![folder, position as i64],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn list_folder_colors(&self) -> Result<std::collections::HashMap<String, String>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT folder, color FROM folder_colors")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn set_folder_color(&self, folder: &str, color: Option<&str>) -> Result<(), String> {
        let conn = self.lock();
        match color {
            Some(c) => conn
                .execute(
                    "INSERT OR REPLACE INTO folder_colors (folder, color) VALUES (?1, ?2)",
                    params![folder, c],
                )
                .map_err(db_err)?,
            None => conn
                .execute("DELETE FROM folder_colors WHERE folder = ?1", params![folder])
                .map_err(db_err)?,
        };
        Ok(())
    }

    /// Stream のクエリに確実に合致しなくなったアイテムのリンクを外し、外した件数を返す。
    /// query は改行区切りの複数条件セット(OR)。「すべての条件セットに違反する」
    /// 場合のみ外す。ローカル判定できない条件セットが 1 つでもあれば何も外さない。
    pub fn prune_stream_links(&self, stream_id: i64, query: &str) -> Result<usize, String> {
        let filters_list: Vec<LocalFilters> = query
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(parse_local_filters)
            .collect();
        if filters_list.is_empty() || filters_list.iter().any(|f| *f == LocalFilters::default()) {
            return Ok(0);
        }
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT i.url, i.kind, i.state, i.is_draft, i.repo FROM items i
                 JOIN stream_items si ON si.item_url = i.url
                 WHERE si.stream_id = ?1",
            )
            .map_err(db_err)?;
        let rows: Vec<(String, String, String, bool, String)> = stmt
            .query_map(params![stream_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        drop(stmt);

        let to_remove: Vec<&String> = rows
            .iter()
            .filter(|(_, kind, state, is_draft, repo)| {
                filters_list.iter().all(|f| f.violates(kind, state, *is_draft, repo))
            })
            .map(|(url, ..)| url)
            .collect();
        for url in &to_remove {
            conn.execute(
                "DELETE FROM stream_items WHERE stream_id = ?1 AND item_url = ?2",
                params![stream_id, url],
            )
            .map_err(db_err)?;
        }
        if !to_remove.is_empty() {
            conn.execute(
                "DELETE FROM items WHERE url NOT IN (SELECT item_url FROM stream_items)
                   AND url NOT IN (SELECT item_url FROM epic_items)",
                [],
            )
            .map_err(db_err)?;
        }
        Ok(to_remove.len())
    }

    /// 詳細取得などで判明したアイテムの最新状態を反映し、
    /// 合致しなくなった Stream からリンクを掃除して、掃除した Stream の id を返す。
    pub fn refresh_item_state(
        &self,
        url: &str,
        state: &str,
        is_draft: bool,
    ) -> Result<Vec<i64>, String> {
        let linked: Vec<(i64, String)> = {
            let conn = self.lock();
            // updated_at には触れない(未読状態を変えないため)
            conn.execute(
                "UPDATE items SET state = ?2, is_draft = ?3 WHERE url = ?1",
                params![url, state, is_draft],
            )
            .map_err(db_err)?;
            let mut stmt = conn
                .prepare(
                    "SELECT s.id, s.query FROM streams s
                     JOIN stream_items si ON si.stream_id = s.id
                     WHERE si.item_url = ?1",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![url], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?
                .collect::<Result<_, _>>()
                .map_err(db_err)?;
            rows
        };

        let mut pruned_streams = Vec::new();
        for (stream_id, query) in linked {
            if self.prune_stream_links(stream_id, &query)? > 0 {
                pruned_streams.push(stream_id);
            }
        }
        Ok(pruned_streams)
    }

    // ---- Epic (Issue/PR の横断グルーピングとリリース順管理) ----

    pub fn list_epics(&self) -> Result<Vec<Epic>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.name, e.note, e.color, e.position, e.archived,
                   (SELECT COUNT(*) FROM epic_items ei WHERE ei.epic_id = e.id),
                   (SELECT COUNT(*) FROM epic_items ei JOIN items i ON i.url = ei.item_url
                     WHERE ei.epic_id = e.id AND i.state IN ('CLOSED', 'MERGED'))
                 FROM epics e ORDER BY e.archived, e.position, e.id",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], row_to_epic)
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn get_epic(&self, id: i64) -> Result<Epic, String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT e.id, e.name, e.note, e.color, e.position, e.archived,
               (SELECT COUNT(*) FROM epic_items ei WHERE ei.epic_id = e.id),
               (SELECT COUNT(*) FROM epic_items ei JOIN items i ON i.url = ei.item_url
                 WHERE ei.epic_id = e.id AND i.state IN ('CLOSED', 'MERGED'))
             FROM epics e WHERE e.id = ?1",
            params![id],
            row_to_epic,
        )
        .map_err(db_err)
    }

    pub fn create_epic(&self, name: &str, note: Option<&str>, color: Option<&str>) -> Result<i64, String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO epics (name, note, color, position)
             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position) + 1, 0) FROM epics))",
            params![name, note, color],
        )
        .map_err(db_err)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_epic(&self, id: i64, name: &str, note: Option<&str>, color: Option<&str>) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE epics SET name = ?2, note = ?3, color = ?4 WHERE id = ?1",
            params![id, name, note, color],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn delete_epic(&self, id: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM epics WHERE id = ?1", params![id]).map_err(db_err)?;
        conn.execute(
            "DELETE FROM items WHERE url NOT IN (SELECT item_url FROM stream_items)
               AND url NOT IN (SELECT item_url FROM epic_items)",
            [],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn set_epic_archived(&self, id: i64, archived: bool) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE epics SET archived = ?2 WHERE id = ?1",
            params![id, archived],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn list_epic_items(&self, epic_id: i64) -> Result<Vec<EpicRow>, String> {
        let conn = self.lock();
        let sql = format!(
            "SELECT i.kind, i.number, i.title, i.url, i.state, i.is_draft, i.updated_at,
                    i.author, i.author_avatar, i.repo, i.comments, i.milestone, i.assignees,
                    (SELECT GROUP_CONCAT(ei.epic_id) FROM epic_items ei WHERE ei.item_url = i.url), {IS_READ_EXPR},
                    ei.position
             FROM epic_items ei
             JOIN items i ON i.url = ei.item_url
             LEFT JOIN read_state r ON r.item_url = i.url
             WHERE ei.epic_id = ?1
             ORDER BY ei.position, i.number"
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(params![epic_id], |row| {
                Ok(EpicRow {
                    item: StoredItem {
                        kind: row.get(0)?,
                        number: row.get(1)?,
                        title: row.get(2)?,
                        url: row.get(3)?,
                        state: row.get(4)?,
                        is_draft: row.get(5)?,
                        updated_at: row.get(6)?,
                        author: row.get(7)?,
                        author_avatar: row.get(8)?,
                        repo: row.get(9)?,
                        comments: row.get(10)?,
                        milestone: row.get(11)?,
                        assignees: split_assignees(row.get::<_, String>(12)?),
                        epic_ids: split_epic_ids(row.get::<_, Option<String>>(13)?),
                        is_read: row.get(14)?,
                    },
                    epic_position: row.get(15)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn add_epic_item(&self, epic_id: i64, item_url: &str) -> Result<(), String> {
        let conn = self.lock();
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE url = ?1", params![item_url], |r| r.get(0))
            .map_err(db_err)?;
        if exists == 0 {
            return Err("このアイテムはまだ取り込まれていません".into());
        }
        conn.execute(
            "INSERT OR IGNORE INTO epic_items (epic_id, item_url, position)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position) + 1, 0) FROM epic_items WHERE epic_id = ?1))",
            params![epic_id, item_url],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn remove_epic_item(&self, epic_id: i64, item_url: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM epic_items WHERE epic_id = ?1 AND item_url = ?2",
            params![epic_id, item_url],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM items WHERE url NOT IN (SELECT item_url FROM stream_items)
               AND url NOT IN (SELECT item_url FROM epic_items)",
            [],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// リリース順(配列の並び)どおりに position を振り直す
    pub fn reorder_epic_items(&self, epic_id: i64, urls: &[String]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        for (position, url) in urls.iter().enumerate() {
            tx.execute(
                "UPDATE epic_items SET position = ?3 WHERE epic_id = ?1 AND item_url = ?2",
                params![epic_id, url, position as i64],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    /// 同じマイルストーン(リポジトリ単位)で2件以上あるグループをエピック候補として返す
    pub fn suggest_epics(&self) -> Result<Vec<EpicSuggestion>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT milestone, repo, COUNT(*) AS c FROM items
                 WHERE milestone IS NOT NULL AND milestone != ''
                 GROUP BY milestone, repo HAVING c >= 2
                 ORDER BY c DESC, milestone",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(EpicSuggestion { milestone: row.get(0)?, repo: row.get(1)?, count: row.get(2)? })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    /// 提案からエピックを作成し、該当アイテムを番号順で一括追加する
    pub fn create_epic_from_milestone(&self, milestone: &str, repo: &str) -> Result<i64, String> {
        let epic_id = self.create_epic(milestone, Some(repo), None)?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO epic_items (epic_id, item_url, position)
             SELECT ?1, url, ROW_NUMBER() OVER (ORDER BY number) - 1
             FROM items WHERE milestone = ?2 AND repo = ?3",
            params![epic_id, milestone, repo],
        )
        .map_err(db_err)?;
        Ok(epic_id)
    }

    pub fn item_epic_ids(&self, item_url: &str) -> Result<Vec<i64>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT epic_id FROM epic_items WHERE item_url = ?1 ORDER BY epic_id")
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![item_url], |row| row.get(0))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    /// 全 Stream に対して掃除を実行し、1件でも外した Stream の id を返す。
    /// 状態の一括更新(エピックのリフレッシュ等)の後に呼ぶ。
    pub fn prune_all_streams(&self) -> Result<Vec<i64>, String> {
        let streams: Vec<(i64, String)> = {
            let conn = self.lock();
            let mut stmt = conn
                .prepare("SELECT id, query FROM streams")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?
                .collect::<Result<_, _>>()
                .map_err(db_err)?;
            rows
        };
        let mut pruned = Vec::new();
        for (id, query) in streams {
            if self.prune_stream_links(id, &query)? > 0 {
                pruned.push(id);
            }
        }
        Ok(pruned)
    }

    /// バッチ取得した最新状態を反映する(updated_at には触れない = 未読を変えない)
    pub fn update_item_states(&self, states: &[crate::github::ItemStatus]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        for st in states {
            tx.execute(
                "UPDATE items SET state = ?2, is_draft = ?3, title = ?4, milestone = ?5 WHERE url = ?1",
                params![st.url, st.state, st.is_draft, st.title, st.milestone],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn list_graph_repos(&self) -> Result<Vec<String>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT repo FROM graph_repos ORDER BY position, repo")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    pub fn add_graph_repo(&self, repo: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO graph_repos (repo, position)
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM graph_repos))",
            params![repo],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn remove_graph_repo(&self, repo: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM graph_repos WHERE repo = ?1", params![repo])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn set_polled(&self, id: i64, now: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE streams SET last_polled_at = ?2 WHERE id = ?1",
            params![id, now],
        )
        .map_err(db_err)?;
        Ok(())
    }
}

fn split_assignees(raw: String) -> Vec<String> {
    if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',').map(String::from).collect()
    }
}

fn split_epic_ids(raw: Option<String>) -> Vec<i64> {
    raw.map(|r| r.split(',').filter_map(|p| p.parse().ok()).collect())
        .unwrap_or_default()
}

fn row_to_epic(row: &rusqlite::Row<'_>) -> rusqlite::Result<Epic> {
    Ok(Epic {
        id: row.get(0)?,
        name: row.get(1)?,
        note: row.get(2)?,
        color: row.get(3)?,
        position: row.get(4)?,
        archived: row.get(5)?,
        item_count: row.get(6)?,
        done_count: row.get(7)?,
    })
}

fn row_to_stream(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stream> {
    Ok(Stream {
        id: row.get(0)?,
        name: row.get(1)?,
        query: row.get(2)?,
        folder: row.get(3)?,
        interval_sec: row.get(4)?,
        enabled: row.get(5)?,
        position: row.get(6)?,
        color: row.get(7)?,
        unread_count: row.get(8)?,
        total_count: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::init(Connection::open_in_memory().expect("in-memory db")).expect("init")
    }

    fn item(url: &str, updated_at: &str) -> Item {
        Item {
            kind: "issue".into(),
            number: 1,
            title: format!("title of {url}"),
            url: url.into(),
            state: "OPEN".into(),
            is_draft: false,
            updated_at: updated_at.into(),
            author: Some("alice".into()),
            author_avatar: None,
            repo: "o/r".into(),
            comments: 0,
            milestone: None,
            assignees: Vec::new(),
        }
    }

    #[test]
    fn seeds_default_stream_on_first_run() {
        let db = test_db();
        let streams = db.list_streams().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].query, "involves:@me sort:updated-desc");
    }

    #[test]
    fn stream_crud_roundtrip() {
        let db = test_db();
        let id = db.create_stream("PRs", "is:pr review-requested:@me", Some("work"), 90, None).unwrap();
        let s = db.get_stream(id).unwrap();
        assert_eq!((s.name.as_str(), s.folder.as_deref(), s.interval_sec, s.enabled),
                   ("PRs", Some("work"), 90, true));

        db.update_stream(id, "PRs2", "is:pr author:@me", None, 60, false, None).unwrap();
        let s = db.get_stream(id).unwrap();
        assert_eq!((s.name.as_str(), s.folder.as_deref(), s.enabled), ("PRs2", None, false));

        db.delete_stream(id).unwrap();
        assert!(db.get_stream(id).is_err());
    }

    #[test]
    fn interval_is_clamped_to_60s_minimum() {
        let db = test_db();
        let id = db.create_stream("fast", "q", None, 5, None).unwrap();
        assert_eq!(db.get_stream(id).unwrap().interval_sec, 60);
    }

    #[test]
    fn unread_lifecycle() {
        let db = test_db();
        let id = db.create_stream("s", "q", None, 60, None).unwrap();

        let fresh = db.upsert_items(id, &[item("u1", "2026-07-09T00:00:00Z")]).unwrap();
        assert_eq!(fresh.len(), 1, "new item should be fresh");
        assert_eq!(db.get_stream(id).unwrap().unread_count, 1);

        db.mark_read("u1").unwrap();
        assert_eq!(db.get_stream(id).unwrap().unread_count, 0);
        assert!(db.list_items(id, false).unwrap()[0].is_read);
        assert!(db.list_items(id, true).unwrap().is_empty());

        // 同じ updated_at の再取得は fresh 扱いにならず、未読にも戻らない
        let fresh = db.upsert_items(id, &[item("u1", "2026-07-09T00:00:00Z")]).unwrap();
        assert!(fresh.is_empty());
        assert_eq!(db.get_stream(id).unwrap().unread_count, 0);

        // 更新されたら fresh になり未読へ戻る
        let fresh = db.upsert_items(id, &[item("u1", "2026-07-09T01:00:00Z")]).unwrap();
        assert_eq!(fresh.len(), 1);
        assert_eq!(db.get_stream(id).unwrap().unread_count, 1);

        db.mark_read("u1").unwrap();
        db.mark_unread("u1").unwrap();
        assert_eq!(db.get_stream(id).unwrap().unread_count, 1);
    }

    #[test]
    fn mark_all_read_covers_only_that_stream() {
        let db = test_db();
        let a = db.create_stream("a", "qa", None, 60, None).unwrap();
        let b = db.create_stream("b", "qb", None, 60, None).unwrap();
        db.upsert_items(a, &[item("u1", "2026-07-09T00:00:00Z")]).unwrap();
        db.upsert_items(b, &[item("u2", "2026-07-09T00:00:00Z")]).unwrap();

        db.mark_all_read(a).unwrap();
        assert_eq!(db.get_stream(a).unwrap().unread_count, 0);
        assert_eq!(db.get_stream(b).unwrap().unread_count, 1);
    }

    #[test]
    fn delete_stream_cleans_up_orphan_items() {
        let db = test_db();
        let a = db.create_stream("a", "qa", None, 60, None).unwrap();
        let b = db.create_stream("b", "qb", None, 60, None).unwrap();
        db.upsert_items(a, &[item("both", "2026-07-09T00:00:00Z"), item("only-a", "2026-07-09T00:00:00Z")]).unwrap();
        db.upsert_items(b, &[item("both", "2026-07-09T00:00:00Z")]).unwrap();

        db.delete_stream(a).unwrap();
        // both は b から参照されているので残る
        let b_items = db.list_items(b, false).unwrap();
        assert_eq!(b_items.len(), 1);
        assert_eq!(b_items[0].url, "both");
    }

    #[test]
    fn list_items_limits_to_500_and_filters_before_limit() {
        let db = test_db();
        let id = db.create_stream("big", "q", None, 60, None).unwrap();
        let items: Vec<Item> = (0..501)
            .map(|i| item(&format!("u{i:03}"), &format!("2026-01-01T00:{:02}:{:02}Z", i / 60, i % 60)))
            .collect();
        db.upsert_items(id, &items).unwrap();

        // 最古の u000 だけが LIMIT 500 で切り落とされる(updated_at 降順)
        let all = db.list_items(id, false).unwrap();
        assert_eq!(all.len(), 500);
        assert!(all.iter().all(|i| i.url != "u000"));
        assert_eq!(all[0].url, "u500");

        // 両端(最新・最古)を既読にしても unread_only は LIMIT の前に効く
        db.mark_read("u000").unwrap();
        db.mark_read("u500").unwrap();
        let unread = db.list_items(id, true).unwrap();
        assert_eq!(unread.len(), 499);
        assert!(unread.iter().all(|i| i.url != "u000" && i.url != "u500"));
    }

    #[test]
    fn delete_stream_cascades_read_state() {
        let db = test_db();
        let id = db.create_stream("s", "q", None, 60, None).unwrap();
        db.upsert_items(id, &[item("u1", "2026-07-09T00:00:00Z")]).unwrap();
        db.mark_read("u1").unwrap();

        db.delete_stream(id).unwrap();
        let conn = db.lock();
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM read_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "read_state must not leak after stream deletion");
    }

    #[test]
    fn due_streams_respects_interval_and_enabled() {
        let db = test_db();
        let seeded = db.list_streams().unwrap()[0].id;
        let id = db.create_stream("s", "q", None, 60, None).unwrap();
        db.update_stream(seeded, "off", "q", None, 60, false, None).unwrap();

        // 未ポーリングの enabled stream は first_poll=true で due
        let due = db.due_streams(1000).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, id);
        assert!(due[0].first_poll);

        db.set_polled(id, 1000).unwrap();
        assert!(db.due_streams(1030).unwrap().is_empty(), "within interval");
        let due = db.due_streams(1060).unwrap();
        assert_eq!(due.len(), 1, "past interval");
        assert!(!due[0].first_poll);
    }

    fn pr_item(url: &str, state: &str, is_draft: bool, repo: &str) -> Item {
        Item {
            kind: "pr".into(),
            number: 1,
            title: format!("title of {url}"),
            url: url.into(),
            state: state.into(),
            is_draft,
            updated_at: "2026-07-09T00:00:00Z".into(),
            author: None,
            author_avatar: None,
            repo: repo.into(),
            comments: 0,
            milestone: None,
            assignees: Vec::new(),
        }
    }

    #[test]
    fn prune_removes_merged_and_closed_from_open_stream() {
        let db = test_db();
        let id = db.create_stream("open-prs", "is:pr is:open repo:o/r sort:updated-desc", None, 60, None).unwrap();
        db.upsert_items(
            id,
            &[
                pr_item("u-open", "OPEN", false, "o/r"),
                pr_item("u-merged", "MERGED", false, "o/r"),
                pr_item("u-closed", "CLOSED", false, "o/r"),
            ],
        )
        .unwrap();

        let pruned = db.prune_stream_links(id, "is:pr is:open repo:o/r sort:updated-desc").unwrap();
        assert_eq!(pruned, 2);
        let urls: Vec<String> = db.list_items(id, false).unwrap().into_iter().map(|i| i.url).collect();
        assert_eq!(urls, ["u-open"]);
    }

    #[test]
    fn prune_is_closed_keeps_merged_prs() {
        // GitHub の is:closed は merged を含むため merged は残す
        let db = test_db();
        let id = db.create_stream("closed", "is:closed", None, 60, None).unwrap();
        db.upsert_items(
            id,
            &[
                pr_item("u-merged", "MERGED", false, "o/r"),
                pr_item("u-closed", "CLOSED", false, "o/r"),
                pr_item("u-open", "OPEN", false, "o/r"),
            ],
        )
        .unwrap();
        assert_eq!(db.prune_stream_links(id, "is:closed").unwrap(), 1);
        let urls: Vec<String> = db.list_items(id, false).unwrap().into_iter().map(|i| i.url).collect();
        assert!(urls.contains(&"u-merged".to_string()) && urls.contains(&"u-closed".to_string()));
    }

    #[test]
    fn prune_respects_repo_org_and_draft_filters() {
        let db = test_db();
        let id = db.create_stream("s", "org:love-rox -is:draft", None, 60, None).unwrap();
        db.upsert_items(
            id,
            &[
                pr_item("u-ok", "OPEN", false, "Love-Rox/Harushion"),
                pr_item("u-other-org", "OPEN", false, "other/repo"),
                pr_item("u-draft", "OPEN", true, "Love-Rox/Harushion"),
            ],
        )
        .unwrap();
        assert_eq!(db.prune_stream_links(id, "org:love-rox -is:draft").unwrap(), 2);
        let urls: Vec<String> = db.list_items(id, false).unwrap().into_iter().map(|i| i.url).collect();
        assert_eq!(urls, ["u-ok"]);
    }

    #[test]
    fn prune_multi_query_keeps_items_matching_any_set() {
        let db = test_db();
        let q = "is:pr is:open\nis:pr is:merged";
        let id = db.create_stream("s", q, None, 60, None).unwrap();
        db.upsert_items(
            id,
            &[
                pr_item("u-open", "OPEN", false, "o/r"),
                pr_item("u-merged", "MERGED", false, "o/r"),
                pr_item("u-closed", "CLOSED", false, "o/r"),
            ],
        )
        .unwrap();

        // OPEN と MERGED はどちらかの条件セットに合致するので残り、CLOSED だけ外れる
        assert_eq!(db.prune_stream_links(id, q).unwrap(), 1);
        let urls: Vec<String> = db.list_items(id, false).unwrap().into_iter().map(|i| i.url).collect();
        assert!(urls.contains(&"u-open".to_string()) && urls.contains(&"u-merged".to_string()));
        assert!(!urls.contains(&"u-closed".to_string()));
    }

    #[test]
    fn prune_multi_query_skips_when_any_set_is_unjudgeable() {
        let db = test_db();
        let q = "is:pr is:open\ninvolves:@me";
        let id = db.create_stream("s", q, None, 60, None).unwrap();
        db.upsert_items(id, &[pr_item("u-closed", "CLOSED", false, "o/r")]).unwrap();
        // involves:@me はローカル判定不能 → そちらに合致している可能性があるので何も外さない
        assert_eq!(db.prune_stream_links(id, q).unwrap(), 0);
    }

    #[test]
    fn prune_does_nothing_without_local_filters() {
        let db = test_db();
        let id = db.create_stream("s", "involves:@me sort:updated-desc", None, 60, None).unwrap();
        db.upsert_items(id, &[pr_item("u1", "MERGED", false, "o/r")]).unwrap();
        assert_eq!(db.prune_stream_links(id, "involves:@me sort:updated-desc").unwrap(), 0);
        assert_eq!(db.list_items(id, false).unwrap().len(), 1);
    }

    #[test]
    fn refresh_item_state_prunes_streams_that_no_longer_match() {
        let db = test_db();
        let open_stream = db.create_stream("open", "is:pr is:open", None, 60, None).unwrap();
        let all_stream = db.create_stream("all", "involves:@me", None, 60, None).unwrap();
        db.upsert_items(open_stream, &[pr_item("u1", "OPEN", false, "o/r")]).unwrap();
        db.upsert_items(all_stream, &[pr_item("u1", "OPEN", false, "o/r")]).unwrap();

        // 詳細取得でマージ済みと判明 → open Stream からだけ外れる
        let pruned = db.refresh_item_state("u1", "MERGED", false).unwrap();
        assert_eq!(pruned, [open_stream]);
        assert!(db.list_items(open_stream, false).unwrap().is_empty());
        let all_items = db.list_items(all_stream, false).unwrap();
        assert_eq!(all_items.len(), 1);
        assert_eq!(all_items[0].state, "MERGED");
    }


    fn ms_item(url: &str, milestone: Option<&str>, number: i64) -> Item {
        Item {
            kind: "issue".into(),
            number,
            title: format!("title of {url}"),
            url: url.into(),
            state: "OPEN".into(),
            is_draft: false,
            updated_at: "2026-07-09T00:00:00Z".into(),
            author: None,
            author_avatar: None,
            repo: "o/r".into(),
            comments: 0,
            milestone: milestone.map(String::from),
            assignees: Vec::new(),
        }
    }

    #[test]
    fn epic_crud_and_progress() {
        let db = test_db();
        let sid = db.create_stream("s", "q", None, 60, None).unwrap();
        db.upsert_items(sid, &[pr_item("u1", "OPEN", false, "o/r"), pr_item("u2", "MERGED", false, "o/r")]).unwrap();

        let eid = db.create_epic("v1 リリース", Some("メモ"), Some("6366f1")).unwrap();
        db.add_epic_item(eid, "u1").unwrap();
        db.add_epic_item(eid, "u2").unwrap();

        let epic = db.get_epic(eid).unwrap();
        assert_eq!((epic.item_count, epic.done_count), (2, 1), "MERGED は done 扱い");

        db.update_epic(eid, "v1", None, None).unwrap();
        assert_eq!(db.get_epic(eid).unwrap().name, "v1");

        db.delete_epic(eid).unwrap();
        assert!(db.get_epic(eid).is_err());
        // Stream には残っているのでアイテムは消えない
        assert_eq!(db.list_items(sid, false).unwrap().len(), 2);
    }

    #[test]
    fn epic_items_keep_release_order_and_reorder() {
        let db = test_db();
        let sid = db.create_stream("s", "q", None, 60, None).unwrap();
        db.upsert_items(sid, &[
            pr_item("u1", "OPEN", false, "o/r"),
            pr_item("u2", "OPEN", false, "o/r"),
            pr_item("u3", "OPEN", false, "o/r"),
        ]).unwrap();
        let eid = db.create_epic("e", None, None).unwrap();
        for u in ["u1", "u2", "u3"] {
            db.add_epic_item(eid, u).unwrap();
        }
        let urls: Vec<String> = db.list_epic_items(eid).unwrap().into_iter().map(|r| r.item.url).collect();
        assert_eq!(urls, ["u1", "u2", "u3"], "追加順が初期リリース順");

        db.reorder_epic_items(eid, &["u3".into(), "u1".into(), "u2".into()]).unwrap();
        let urls: Vec<String> = db.list_epic_items(eid).unwrap().into_iter().map(|r| r.item.url).collect();
        assert_eq!(urls, ["u3", "u1", "u2"]);
    }

    #[test]
    fn epic_items_survive_stream_deletion() {
        let db = test_db();
        let sid = db.create_stream("s", "q", None, 60, None).unwrap();
        db.upsert_items(sid, &[pr_item("u1", "OPEN", false, "o/r")]).unwrap();
        let eid = db.create_epic("e", None, None).unwrap();
        db.add_epic_item(eid, "u1").unwrap();

        // Stream を消してもエピック参照があるのでアイテムは残る
        db.delete_stream(sid).unwrap();
        assert_eq!(db.list_epic_items(eid).unwrap().len(), 1);

        // エピックからも外すと掃除される
        db.remove_epic_item(eid, "u1").unwrap();
        let conn = db.lock();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn epic_archive_toggle() {
        let db = test_db();
        let eid = db.create_epic("e", None, None).unwrap();
        assert!(!db.get_epic(eid).unwrap().archived);
        db.set_epic_archived(eid, true).unwrap();
        assert!(db.get_epic(eid).unwrap().archived);
        // アーカイブは末尾に並ぶ
        let e2 = db.create_epic("f", None, None).unwrap();
        let ids: Vec<i64> = db.list_epics().unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [e2, eid]);
        db.set_epic_archived(eid, false).unwrap();
        assert!(!db.get_epic(eid).unwrap().archived);
    }

    #[test]
    fn suggests_and_creates_epic_from_milestone() {
        let db = test_db();
        let sid = db.create_stream("s", "q", None, 60, None).unwrap();
        db.upsert_items(sid, &[
            ms_item("m1", Some("v2.0"), 3),
            ms_item("m2", Some("v2.0"), 1),
            ms_item("m3", Some("solo"), 2),
            ms_item("m4", None, 4),
        ]).unwrap();

        let suggestions = db.suggest_epics().unwrap();
        assert_eq!(suggestions.len(), 1, "2件未満のグループは提案しない");
        assert_eq!((suggestions[0].milestone.as_str(), suggestions[0].count), ("v2.0", 2));

        let eid = db.create_epic_from_milestone("v2.0", "o/r").unwrap();
        let rows = db.list_epic_items(eid).unwrap();
        let urls: Vec<&str> = rows.iter().map(|r| r.item.url.as_str()).collect();
        assert_eq!(urls, ["m2", "m1"], "番号昇順で初期リリース順が付く");
        assert_eq!(db.item_epic_ids("m1").unwrap(), [eid]);
    }

    #[test]
    fn prune_all_streams_reports_affected_streams() {
        let db = test_db();
        let open_s = db.create_stream("open", "is:pr is:open", None, 60, None).unwrap();
        let all_s = db.create_stream("all", "involves:@me", None, 60, None).unwrap();
        db.upsert_items(open_s, &[pr_item("u1", "OPEN", false, "o/r")]).unwrap();
        db.upsert_items(all_s, &[pr_item("u1", "OPEN", false, "o/r")]).unwrap();

        // エピックのリフレッシュ相当: 状態だけ MERGED に変わった
        db.update_item_states(&[crate::github::ItemStatus {
            url: "u1".into(),
            state: "MERGED".into(),
            is_draft: false,
            title: "t".into(),
            milestone: None,
        }]).unwrap();

        let pruned = db.prune_all_streams().unwrap();
        assert_eq!(pruned, [open_s], "is:open の Stream だけが掃除対象");
        assert!(db.list_items(open_s, false).unwrap().is_empty());
        assert_eq!(db.list_items(all_s, false).unwrap().len(), 1);
    }

    #[test]
    fn reorder_streams_rewrites_positions() {
        let db = test_db();
        let seeded = db.list_streams().unwrap()[0].id;
        let a = db.create_stream("a", "q", None, 60, None).unwrap();
        let b = db.create_stream("b", "q", None, 60, None).unwrap();

        db.reorder_streams(&[b, seeded, a]).unwrap();
        let order: Vec<i64> = db.list_streams().unwrap().iter().map(|s| s.id).collect();
        assert_eq!(order, [b, seeded, a]);
    }

    #[test]
    fn folder_order_roundtrip() {
        let db = test_db();
        assert!(db.list_folder_order().unwrap().is_empty());
        db.reorder_folders(&["work".into(), "oss".into()]).unwrap();
        assert_eq!(db.list_folder_order().unwrap(), ["work", "oss"]);
        db.reorder_folders(&["oss".into(), "work".into(), "misc".into()]).unwrap();
        assert_eq!(db.list_folder_order().unwrap(), ["oss", "work", "misc"]);
    }

    #[test]
    fn stream_color_roundtrip() {
        let db = test_db();
        let id = db.create_stream("c", "q", None, 60, Some("6366f1")).unwrap();
        assert_eq!(db.get_stream(id).unwrap().color.as_deref(), Some("6366f1"));

        db.update_stream(id, "c", "q", None, 60, true, None).unwrap();
        assert_eq!(db.get_stream(id).unwrap().color, None, "color can be cleared");
    }

    #[test]
    fn folder_colors_roundtrip() {
        let db = test_db();
        assert!(db.list_folder_colors().unwrap().is_empty());

        db.set_folder_color("work", Some("16a34a")).unwrap();
        db.set_folder_color("work", Some("e11d48")).unwrap(); // 上書き
        db.set_folder_color("oss", Some("0284c7")).unwrap();
        let colors = db.list_folder_colors().unwrap();
        assert_eq!(colors.get("work").map(String::as_str), Some("e11d48"));
        assert_eq!(colors.len(), 2);

        db.set_folder_color("work", None).unwrap();
        assert_eq!(db.list_folder_colors().unwrap().len(), 1);
    }

    #[test]
    fn graph_repos_roundtrip_preserves_order_and_dedupes() {
        let db = test_db();
        db.add_graph_repo("o/b").unwrap();
        db.add_graph_repo("o/a").unwrap();
        db.add_graph_repo("o/b").unwrap(); // 重複は無視
        assert_eq!(db.list_graph_repos().unwrap(), ["o/b", "o/a"]);

        db.remove_graph_repo("o/b").unwrap();
        assert_eq!(db.list_graph_repos().unwrap(), ["o/a"]);
    }

    #[test]
    fn query_change_resets_poll_schedule() {
        let db = test_db();
        let seeded = db.list_streams().unwrap()[0].id;
        db.update_stream(seeded, "off", "q", None, 60, false, None).unwrap();
        let id = db.create_stream("s", "q", None, 60, None).unwrap();
        db.set_polled(id, 1000).unwrap();

        db.update_stream(id, "s", "q", None, 60, true, None).unwrap();
        assert!(db.due_streams(1010).unwrap().is_empty(), "same query keeps schedule");

        db.update_stream(id, "s", "q2", None, 60, true, None).unwrap();
        let due = db.due_streams(1010).unwrap();
        assert_eq!(due.len(), 1, "changed query is due immediately");
        assert!(due[0].first_poll);
    }
}
