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
    pub is_read: bool,
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
  comments INTEGER NOT NULL DEFAULT 0
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
"#;

// 既読判定: read_state があり、既読にした時点の updated_at 以降更新されていないこと
const IS_READ_EXPR: &str =
    "(r.last_read_updated_at IS NOT NULL AND r.last_read_updated_at >= i.updated_at)";

fn db_err(e: rusqlite::Error) -> String {
    format!("データベースエラー: {e}")
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
            "SELECT s.id, s.name, s.query, s.folder, s.interval_sec, s.enabled, s.position,
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
            "SELECT s.id, s.name, s.query, s.folder, s.interval_sec, s.enabled, s.position,
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
    ) -> Result<i64, String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO streams (name, query, folder, interval_sec, position)
             VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position) + 1, 0) FROM streams))",
            params![name, query, folder, interval_sec.max(60)],
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
    ) -> Result<(), String> {
        let conn = self.lock();
        // クエリが変わったら次の tick で即再取得されるよう last_polled_at をリセット
        conn.execute(
            "UPDATE streams SET name = ?2, query = ?3, folder = ?4, interval_sec = ?5, enabled = ?6,
               last_polled_at = CASE WHEN query = ?3 THEN last_polled_at ELSE NULL END
             WHERE id = ?1",
            params![id, name, query, folder, interval_sec.max(60), enabled],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn delete_stream(&self, id: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM streams WHERE id = ?1", params![id])
            .map_err(db_err)?;
        // どの Stream からも参照されなくなったアイテムを掃除(read_state は FK CASCADE)
        conn.execute(
            "DELETE FROM items WHERE url NOT IN (SELECT item_url FROM stream_items)",
            [],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn list_items(&self, stream_id: i64, unread_only: bool) -> Result<Vec<StoredItem>, String> {
        let conn = self.lock();
        let sql = format!(
            "SELECT i.kind, i.number, i.title, i.url, i.state, i.is_draft, i.updated_at,
                    i.author, i.author_avatar, i.repo, i.comments, {IS_READ_EXPR}
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
                    is_read: row.get(11)?,
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
                                    author, author_avatar, repo, comments)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(url) DO UPDATE SET
                   kind = excluded.kind, number = excluded.number, title = excluded.title,
                   state = excluded.state, is_draft = excluded.is_draft,
                   updated_at = excluded.updated_at, author = excluded.author,
                   author_avatar = excluded.author_avatar, repo = excluded.repo,
                   comments = excluded.comments",
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
                    item.comments
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

fn row_to_stream(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stream> {
    Ok(Stream {
        id: row.get(0)?,
        name: row.get(1)?,
        query: row.get(2)?,
        folder: row.get(3)?,
        interval_sec: row.get(4)?,
        enabled: row.get(5)?,
        position: row.get(6)?,
        unread_count: row.get(7)?,
        total_count: row.get(8)?,
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
        let id = db.create_stream("PRs", "is:pr review-requested:@me", Some("work"), 90).unwrap();
        let s = db.get_stream(id).unwrap();
        assert_eq!((s.name.as_str(), s.folder.as_deref(), s.interval_sec, s.enabled),
                   ("PRs", Some("work"), 90, true));

        db.update_stream(id, "PRs2", "is:pr author:@me", None, 60, false).unwrap();
        let s = db.get_stream(id).unwrap();
        assert_eq!((s.name.as_str(), s.folder.as_deref(), s.enabled), ("PRs2", None, false));

        db.delete_stream(id).unwrap();
        assert!(db.get_stream(id).is_err());
    }

    #[test]
    fn interval_is_clamped_to_60s_minimum() {
        let db = test_db();
        let id = db.create_stream("fast", "q", None, 5).unwrap();
        assert_eq!(db.get_stream(id).unwrap().interval_sec, 60);
    }

    #[test]
    fn unread_lifecycle() {
        let db = test_db();
        let id = db.create_stream("s", "q", None, 60).unwrap();

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
        let a = db.create_stream("a", "qa", None, 60).unwrap();
        let b = db.create_stream("b", "qb", None, 60).unwrap();
        db.upsert_items(a, &[item("u1", "2026-07-09T00:00:00Z")]).unwrap();
        db.upsert_items(b, &[item("u2", "2026-07-09T00:00:00Z")]).unwrap();

        db.mark_all_read(a).unwrap();
        assert_eq!(db.get_stream(a).unwrap().unread_count, 0);
        assert_eq!(db.get_stream(b).unwrap().unread_count, 1);
    }

    #[test]
    fn delete_stream_cleans_up_orphan_items() {
        let db = test_db();
        let a = db.create_stream("a", "qa", None, 60).unwrap();
        let b = db.create_stream("b", "qb", None, 60).unwrap();
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
        let id = db.create_stream("big", "q", None, 60).unwrap();
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
        let id = db.create_stream("s", "q", None, 60).unwrap();
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
        let id = db.create_stream("s", "q", None, 60).unwrap();
        db.update_stream(seeded, "off", "q", None, 60, false).unwrap();

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

    #[test]
    fn query_change_resets_poll_schedule() {
        let db = test_db();
        let seeded = db.list_streams().unwrap()[0].id;
        db.update_stream(seeded, "off", "q", None, 60, false).unwrap();
        let id = db.create_stream("s", "q", None, 60).unwrap();
        db.set_polled(id, 1000).unwrap();

        db.update_stream(id, "s", "q", None, 60, true).unwrap();
        assert!(db.due_streams(1010).unwrap().is_empty(), "same query keeps schedule");

        db.update_stream(id, "s", "q2", None, 60, true).unwrap();
        let due = db.due_streams(1010).unwrap();
        assert_eq!(due.len(), 1, "changed query is due immediately");
        assert!(due[0].first_poll);
    }
}
