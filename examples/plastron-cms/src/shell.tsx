import { useCallback, useEffect, useState } from "react";
import type { ContentApi } from "./api/content-api.js";
import type { Content, ContentDraft, ContentSummary } from "./api/types.js";
import { PlastronCMS } from "./PlastronCMS.js";

// ============================================================================
// App shell — sidebar list + main pane viewer/editor.
//
// Hashes:
//   #/                    → empty main pane (placeholder)
//   #/view/<slug>         → render PlastronCMS in view mode
//   #/edit/<slug>         → render PlastronCMS in edit mode
//   #/new                 → create-new editor (saves to a fresh row)
//
// The shell owns API calls (list, get, save, create). PlastronCMS only
// receives the resolved Content + an onSave callback — that's the
// API-shaped boundary that mirrors the eventual grafted deployment.
// ============================================================================

interface Route {
  view: "empty" | "view" | "edit" | "new";
  slug?: string;
}

const parseHash = (h: string): Route => {
  const s = h.startsWith("#") ? h.slice(1) : h;
  if (s === "" || s === "/") return { view: "empty" };
  const m = /^\/(view|edit)\/(.+)$/.exec(s);
  if (m) return { view: m[1] as "view" | "edit", slug: m[2] };
  if (s === "/new") return { view: "new" };
  return { view: "empty" };
};

const navTo = (hash: string): void => {
  if (window.location.hash !== hash) window.location.hash = hash;
};

const blankDraft = (): ContentDraft => ({
  title: "Untitled",
  slug: `untitled-${Date.now()}`,
  description: null,
  blocks: [
    {
      key: "content",
      cels: [{ key: "body", v: "", segment: "content" }],
    },
  ],
  css: null,
});

export const Shell = ({ api }: { api: ContentApi }): React.ReactElement => {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [list, setList] = useState<ContentSummary[]>([]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshList = useCallback(async () => {
    setList(await api.list());
  }, [api]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  return (
    <div className="cms-shell">
      <aside className="sidebar">
        <h2>plastron-cms</h2>
        <nav>
          <a href="#/" className={route.view === "empty" ? "active" : ""}>Home</a>
          <a href="#/new" className={route.view === "new" ? "active" : ""}>+ New content</a>
        </nav>
        <hr />
        <h3>Content</h3>
        <ul className="content-list">
          {list.length === 0 ? (
            <li className="empty">no content yet</li>
          ) : list.map((c) => {
            const activeView = route.view === "view" && route.slug === c.slug;
            const activeEdit = route.view === "edit" && route.slug === c.slug;
            return (
              <li key={c.id} className="content-list__row">
                <a href={`#/view/${c.slug}`} className={activeView ? "active" : ""}>
                  {c.title}
                </a>
                <a href={`#/edit/${c.slug}`} className={"sub " + (activeEdit ? "active" : "")}>
                  edit
                </a>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="main-pane">
        <MainPane api={api} route={route} refreshList={refreshList} />
      </main>
    </div>
  );
};

const MainPane = ({
  api, route, refreshList,
}: { api: ContentApi; route: Route; refreshList: () => Promise<void> }): React.ReactElement => {
  if (route.view === "empty") {
    return (
      <div className="empty-pane">
        <p>Select content from the sidebar, or create new.</p>
      </div>
    );
  }
  if (route.view === "new") {
    return <NewPage api={api} onSaved={refreshList} />;
  }
  if (!route.slug) return <div className="empty-pane">Missing slug.</div>;
  return (
    <ContentPage
      api={api}
      slug={route.slug}
      editMode={route.view === "edit"}
      refreshList={refreshList}
    />
  );
};

const ContentPage = ({
  api, slug, editMode, refreshList,
}: {
  api: ContentApi;
  slug: string;
  editMode: boolean;
  refreshList: () => Promise<void>;
}): React.ReactElement => {
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const c = await api.get(slug);
        if (!alive) return;
        if (!c) setError(`No content with slug "${slug}"`);
        else setContent(c);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [api, slug]);

  const handleSave = useCallback(async (draft: ContentDraft) => {
    if (!content) return;
    await api.save(content.id, draft);
    await refreshList();
    // Reload so PlastronCMS sees the persisted row (in case the
    // backend normalized anything). Re-route if the slug changed.
    const reloaded = await api.get(draft.slug);
    if (reloaded) {
      setContent(reloaded);
      if (draft.slug !== slug) navTo(`#/edit/${draft.slug}`);
    }
  }, [api, content, refreshList, slug]);

  if (error) return <div className="error-pane">{error}</div>;
  if (!content) return <div className="loading">Loading…</div>;

  return (
    <PlastronCMS editMode={editMode} content={content} onSave={handleSave} />
  );
};

const NewPage = ({
  api, onSaved,
}: { api: ContentApi; onSaved: () => Promise<void> }): React.ReactElement => {
  // Local draft state — pre-create. As soon as the user hits save we
  // INSERT and route to the edit page (subsequent saves UPDATE).
  const [seedContent] = useState<Content>(() => ({
    id: "__new__",  // sentinel; replaced by the row id after create
    ...blankDraft(),
  }));

  const handleSave = useCallback(async (next: ContentDraft) => {
    const created = await api.create(next);
    await onSaved();
    navTo(`#/edit/${created.slug}`);
  }, [api, onSaved]);

  return (
    <PlastronCMS editMode content={seedContent} onSave={handleSave} />
  );
};
