import {
  createInitialState, type Fn, type State,
} from "../../../../plastron/src/index.js";
import {
  loadArchive, saveArchive, listArchives, deleteArchive,
} from "../../../../segments/plastron-sqlite/src/index.js";
import type { SqliteHandle } from "../../../../segments/plastron-sqlite/src/index.js";
import { exportArchive, importArchive } from "../../../../segments/plastron-archive/src/index.js";
import { ARTICLE_RENDERER_FNS } from "./renderers.js";
import { buildNewPageSegment } from "./new-page.js";
import { buildNewNewsletterSegment } from "./new-newsletter.js";
import type { ArticleListEntry, ArticleMeta, ArticleType } from "./types.js";

// ============================================================================
// Article ↔ SQLite + plastron State.
//
// Two storage layers:
//   • The `articles` row carries id/slug/title/type/timestamps + the
//     archive blob. plastron-sqlite's helpers don't know about this
//     table — only its own plastron_archives table — so we hand-write
//     the SQL for the cms-shaped table.
//   • The `archive` BLOB column is a .甲 zip wrapping the article's
//     plastron State (one Segment named "article").
//
// articleStateFromSegments builds a fresh plastron State, registers
// the render lambdas, and hydrates the article segment. Callers that
// also want DOM output bind installDom afterwards (the Editor view
// owns this so the host doesn't have to think about per-article
// mounting).
// ============================================================================

interface ArticleRow {
  id: number;
  slug: string;
  title: string;
  type: string;        // page | newsletter
  archive: Uint8Array;
  created_at: string;
  updated_at: string;
}

const isType = (s: string): s is ArticleType =>
  s === "page" || s === "newsletter";

const articleStateFromSegments = (
  segments: Awaited<ReturnType<typeof importArchive>>["segments"],
): State => {
  const state = createInitialState();
  state.fns.get("hydrate")!(state, segments, [ARTICLE_RENDERER_FNS]);
  return state;
};

export const newArticleState = (type: ArticleType): State => {
  const seg = type === "page"
    ? buildNewPageSegment("Untitled page")
    : buildNewNewsletterSegment("Untitled newsletter");
  return articleStateFromSegments([seg]);
};

export const loadArticle = async (
  db: SqliteHandle,
  id: number,
): Promise<{ state: State; meta: ArticleMeta } | null> => {
  // Direct table read; plastron-sqlite's loadArchive is for the
  // generic plastron_archives table.
  const row = await db.get<ArticleRow>(
    `SELECT id, slug, title, type, archive, created_at, updated_at
       FROM articles WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;
  if (!isType(row.type)) {
    throw new Error(`loadArticle: row ${id} has invalid type "${row.type}"`);
  }
  const result = await importArchive(new Uint8Array(row.archive));
  await result.archive.close();
  const state = articleStateFromSegments(result.segments);
  await (state.fns.get("runCycle") as Fn)(state);
  return {
    state,
    meta: { id: row.id, slug: row.slug, title: row.title, type: row.type },
  };
};

export const saveArticle = async (
  db: SqliteHandle,
  meta: Omit<ArticleMeta, "id"> & { id?: number },
  state: State,
): Promise<number> => {
  const dehydrate = state.fns.get("dehydrate") as Fn;
  const segments = dehydrate(state) as Awaited<ReturnType<typeof importArchive>>["segments"];

  // Pull previous bytes to feed exportArchive's history-preserving path.
  let previous: Uint8Array | undefined;
  if (meta.id !== undefined) {
    const prev = await db.get<{ archive: Uint8Array }>(
      `SELECT archive FROM articles WHERE id = ? LIMIT 1`,
      [meta.id],
    );
    if (prev) previous = new Uint8Array(prev.archive);
  }

  const bytes = await exportArchive(segments, {
    ...(previous !== undefined ? { previous } : {}),
    message: `cms: ${meta.id !== undefined ? "update" : "create"} ${meta.slug}`,
  });

  if (meta.id === undefined) {
    await db.run(
      `INSERT INTO articles (slug, title, type, archive)
       VALUES (?, ?, ?, ?)`,
      [meta.slug, meta.title, meta.type, bytes],
    );
    const inserted = await db.get<{ id: number }>(
      `SELECT id FROM articles WHERE slug = ? LIMIT 1`,
      [meta.slug],
    );
    if (!inserted) throw new Error("saveArticle: insert succeeded but row not found");
    return inserted.id;
  } else {
    await db.run(
      `UPDATE articles
         SET slug = ?, title = ?, type = ?, archive = ?,
             updated_at = datetime('now')
       WHERE id = ?`,
      [meta.slug, meta.title, meta.type, bytes, meta.id],
    );
    return meta.id;
  }
};

export const listArticles = async (db: SqliteHandle): Promise<ArticleListEntry[]> => {
  const rows = await db.all<{
    id: number; slug: string; title: string; type: string;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, slug, title, type, created_at, updated_at
       FROM articles
       ORDER BY updated_at DESC`,
  );
  return rows
    .filter((r) => isType(r.type))
    .map((r) => ({
      id: r.id, slug: r.slug, title: r.title, type: r.type as ArticleType,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
};

export const deleteArticle = async (db: SqliteHandle, id: number): Promise<void> => {
  await db.run(`DELETE FROM articles WHERE id = ?`, [id]);
};

// Re-export sqlite helpers for the host so it doesn't have to import
// from two places when the workflow is "delete a generic archive".
// CMS rows live in articles, not plastron_archives, but power users
// might want to interact with the latter directly.
export { loadArchive, saveArchive as saveGenericArchive, listArchives, deleteArchive as deleteGenericArchive };
