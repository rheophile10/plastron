import type { Segment } from "../../../../plastron/src/index.js";

// Article table — articles are zipped plastron States stored in `archive`.
// `type` controls which preview pane the editor mounts (page → DOM,
// newsletter → MJML iframe).
//
// Kept minimal: no users, no comments, no taxonomy. The CMS example is
// about demonstrating composition, not feature-parity with WordPress.
export const cmsMigrations: Segment = {
  key: "migrations",
  cels: [
    {
      key: "001_articles",
      v: `CREATE TABLE IF NOT EXISTS articles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            slug        TEXT UNIQUE NOT NULL,
            title       TEXT NOT NULL,
            type        TEXT NOT NULL CHECK (type IN ('page', 'newsletter')),
            archive     BLOB NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
      segment: "migrations",
    },
    {
      key: "002_articles_index",
      v: "CREATE INDEX IF NOT EXISTS articles_updated ON articles(updated_at DESC)",
      segment: "migrations",
    },
  ],
};
