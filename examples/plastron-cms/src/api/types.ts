import type { Segment } from "../../../../plastron/src/index.js";

// ============================================================================
// The Content shape PlastronCMS works with.
//
// Subset of the eventual Postgres `content` table — only the fields the
// CMS component cares about. Host-app concerns (organization, group,
// visibility, status, nav, structured_data) are deliberately absent;
// they belong to chrome around <PlastronCMS>, not inside it.
//
// `blocks` is the dehydrated plastron cel graph for this content's body.
// In Postgres it lives in a JSONB column; in TypeScript it's `Segment[]`
// — round-tripped via plastron's hydrate/dehydrate.
// ============================================================================

export interface Content {
  id: string;          // UUID; opaque to PlastronCMS
  title: string;
  slug: string;
  description: string | null;
  blocks: Segment[];   // plastron cel graph, dehydrated
  css: string | null;
}

/** Lightweight projection for list views. Avoids loading `blocks` for
 *  every row. */
export interface ContentSummary {
  id: string;
  title: string;
  slug: string;
  description: string | null;
}

/** Shape used when creating a new Content row. `id` is assigned by the
 *  backend on insert. */
export type ContentDraft = Omit<Content, "id">;
