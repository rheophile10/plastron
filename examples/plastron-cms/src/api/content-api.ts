import type { Content, ContentDraft, ContentSummary } from "./types.js";

// ============================================================================
// API contract — the only thing PlastronCMS depends on for persistence.
//
// In the standalone example this is satisfied by pglite-backend.ts
// (Postgres-in-wasm, IDB-persisted). In a real grafted-into-a-real-app
// deployment the same interface is satisfied by fetch() calls against
// the host's REST/RPC endpoints. PlastronCMS code doesn't change.
//
// All methods are async — even though PGLite is sync-ish, modeling them
// as Promises now means the swap to fetch() later is a no-op.
// ============================================================================

export interface ContentApi {
  list(): Promise<ContentSummary[]>;
  get(slug: string): Promise<Content | null>;
  create(draft: ContentDraft): Promise<Content>;
  save(id: string, content: ContentDraft): Promise<void>;
  remove(id: string): Promise<void>;
}
