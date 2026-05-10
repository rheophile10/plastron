import { useCallback, useEffect, useRef, useState } from "react";
import type { Fn, State } from "../../../../plastron/src/index.js";
import type { SqliteHandle } from "../../../../segments/plastron-sqlite/src/index.js";
import { installDom } from "../../../../segments/plastron-dom/src/index.js";
import {
  loadArticle, saveArticle, deleteArticle, newArticleState,
} from "../article/load.js";
import type { ArticleMeta, ArticleType } from "../article/types.js";
import { CelEditor } from "./CelEditor.js";
import { NewsletterPreview } from "./NewsletterPreview.js";

interface Loaded {
  state: State;
  meta: ArticleMeta;
}

// Slug derived from title — lowercase, kebab-cased, ASCII only.
const slugify = (s: string): string =>
  s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

export const ArticleEditor = ({
  db, mode, articleId, newType, onSaved, onDeleted,
}: {
  db: SqliteHandle;
  mode: "edit" | "new";
  articleId?: number;
  newType: ArticleType;
  onSaved: (id: number) => void;
  onDeleted: () => void;
}): React.ReactElement => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const installedRef = useRef<{ dispose: () => void } | null>(null);

  // Load (or create blank) on mount / mode switch.
  useEffect(() => {
    let alive = true;
    setLoaded(null);
    (async () => {
      if (mode === "new") {
        const state = newArticleState(newType);
        const meta: ArticleMeta = {
          id: 0,
          slug: "",
          title: newType === "page" ? "Untitled page" : "Untitled newsletter",
          type: newType,
        };
        if (alive) setLoaded({ state, meta });
      } else if (articleId !== undefined) {
        const result = await loadArticle(db, articleId);
        if (alive && result) setLoaded(result);
      }
    })();
    return () => { alive = false; };
  }, [db, mode, newType, articleId]);

  // Mount the page-preview painter once the state + ref are both ready.
  // Newsletter previews use the iframe path; only "page" needs DOM.
  useEffect(() => {
    if (!loaded || loaded.meta.type !== "page" || !previewRef.current) return;
    // installDom binds the channel + paints into the ref'd div. We
    // pre-create the empty target and let the DOM channel own it.
    const handle = installDom(loaded.state, {
      roots: { main: { element: previewRef.current, cel: "view" } },
      channelKey: `cms-preview-${loaded.meta.id ?? "new"}`,
    });
    // Kick the cascade so initial paint happens.
    void (loaded.state.fns.get("runCycle") as Fn)(loaded.state);
    installedRef.current = {
      dispose: () => {
        handle.channel.dispose();
        loaded.state.channelRegistry.delete(`cms-preview-${loaded.meta.id ?? "new"}`);
      },
    };
    return () => {
      installedRef.current?.dispose();
      installedRef.current = null;
    };
  }, [loaded]);

  const handleSave = useCallback(async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      // Always sync title from the title cel so the sidebar reflects edits.
      const titleVal = (loaded.state.fns.get("get") as Fn)(
        loaded.state,
        loaded.meta.type === "page" ? "title" : "subject",
      ) as string;
      const slug = loaded.meta.slug || slugify(titleVal);
      const id = await saveArticle(db, {
        ...loaded.meta,
        slug,
        title: titleVal,
        ...(loaded.meta.id ? { id: loaded.meta.id } : {}),
      }, loaded.state);
      onSaved(id);
      // Update local meta with the persisted id/slug for subsequent saves.
      setLoaded({ state: loaded.state, meta: { ...loaded.meta, id, slug, title: titleVal } });
    } finally {
      setSaving(false);
    }
  }, [db, loaded, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!loaded || loaded.meta.id === 0) return;
    if (!confirm(`Delete "${loaded.meta.title}"?`)) return;
    await deleteArticle(db, loaded.meta.id);
    onDeleted();
  }, [db, loaded, onDeleted]);

  if (!loaded) return <div className="loading">Loading…</div>;

  const isPage = loaded.meta.type === "page";

  return (
    <div className="editor-view">
      <header className="editor-header">
        <h1>{loaded.meta.title}</h1>
        <span className="type-badge">{loaded.meta.type}</span>
        <div className="spacer" />
        <button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {loaded.meta.id !== 0 && (
          <button onClick={handleDelete} className="danger">Delete</button>
        )}
      </header>
      <div className="editor-split">
        <div className="editor-pane">
          <h2>Cels</h2>
          <CelEditor state={loaded.state} />
        </div>
        <div className="preview-pane">
          <h2>{isPage ? "Page preview" : "Newsletter preview"}</h2>
          {isPage ? (
            <div ref={previewRef} className="page-preview-target" />
          ) : (
            <NewsletterPreview state={loaded.state} viewCel="view" />
          )}
        </div>
      </div>
    </div>
  );
};
