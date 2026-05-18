import { PGlite } from "@electric-sql/pglite";
import type { ContentApi } from "./content-api.js";
import type { Content, ContentDraft, ContentSummary } from "./types.js";
import type { Segment } from "../../../../plastron/src/index.js";

// ============================================================================
// PGLite-backed implementation of ContentApi.
//
// This file is the example-only persistence layer. PlastronCMS does not
// import it — it only sees the ContentApi interface. The eventual grafted
// deployment swaps this for a fetch() layer hitting a real Postgres
// backend; the schema and shape carry over directly.
//
// Schema mirrors the eventual Postgres `content` table, with the
// host-app concerns omitted (no organization_id/group_id FKs, no
// trigger-maintained denorm columns, no nav_*/structured_data — those
// belong to the host's chrome around <PlastronCMS>).
// ============================================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS content (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  blocks      JSONB NOT NULL DEFAULT '[]'::jsonb,
  css         TEXT,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published', 'archived')),
  visibility  TEXT NOT NULL DEFAULT 'public'
              CHECK (visibility IN ('public', 'members', 'group')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

interface ContentRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  blocks: Segment[];
  css: string | null;
}

interface SummaryRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
}

const rowToContent = (r: ContentRow): Content => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  description: r.description,
  blocks: r.blocks,
  css: r.css,
});

const SEED_CONTENT: ContentDraft[] = [
  {
    title: "Welcome",
    slug: "welcome",
    description: "First page in the demo CMS",
    css: null,
    blocks: [
      {
        key: "content",
        cels: [
          {
            key: "body",
            v: "Welcome to the plastron CMS demo.\n\nThis page's body lives in a single plastron cel. Edit mode lets you change it; view mode renders it.",
            segment: "content",
          },
        ],
      },
    ],
  },
  {
    title: "About plastron",
    slug: "about",
    description: "Why this CMS is shaped the way it is",
    css: null,
    blocks: [
      {
        key: "content",
        cels: [
          {
            key: "body",
            v: "plastron-cms is a single React component: <PlastronCMS editMode content onSave>.\n\nIt knows nothing about Postgres. The example wires PGLite behind an API-shaped boundary so the component is byte-identical to its eventual grafted-into-a-real-React-app deployment.",
            segment: "content",
          },
        ],
      },
    ],
  },
];

export const openContentApi = async (): Promise<ContentApi> => {
  const db = new PGlite("idb://plastron-cms");
  await db.exec(SCHEMA_SQL);

  // Seed on empty DB. First-boot only; subsequent boots see the
  // IDB-persisted rows and skip.
  const countRes = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content`,
  );
  if ((countRes.rows[0]?.n ?? 0) === 0) {
    for (const draft of SEED_CONTENT) {
      await db.query(
        `INSERT INTO content (title, slug, description, blocks, css)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [draft.title, draft.slug, draft.description, JSON.stringify(draft.blocks), draft.css],
      );
    }
  }

  const api: ContentApi = {
    async list(): Promise<ContentSummary[]> {
      const r = await db.query<SummaryRow>(
        `SELECT id, title, slug, description
           FROM content
           ORDER BY updated_at DESC`,
      );
      return r.rows;
    },

    async get(slug: string): Promise<Content | null> {
      const r = await db.query<ContentRow>(
        `SELECT id, title, slug, description, blocks, css
           FROM content
           WHERE slug = $1
           LIMIT 1`,
        [slug],
      );
      const row = r.rows[0];
      return row ? rowToContent(row) : null;
    },

    async create(draft: ContentDraft): Promise<Content> {
      const r = await db.query<ContentRow>(
        `INSERT INTO content (title, slug, description, blocks, css)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, title, slug, description, blocks, css`,
        [draft.title, draft.slug, draft.description, JSON.stringify(draft.blocks), draft.css],
      );
      const row = r.rows[0];
      if (!row) throw new Error("create: insert returned no row");
      return rowToContent(row);
    },

    async save(id: string, content: ContentDraft): Promise<void> {
      await db.query(
        `UPDATE content
            SET title = $2,
                slug = $3,
                description = $4,
                blocks = $5::jsonb,
                css = $6,
                updated_at = now()
          WHERE id = $1`,
        [id, content.title, content.slug, content.description,
         JSON.stringify(content.blocks), content.css],
      );
    },

    async remove(id: string): Promise<void> {
      await db.query(`DELETE FROM content WHERE id = $1`, [id]);
    },
  };

  return api;
};
