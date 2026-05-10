import { useCallback, useEffect, useState } from "react";
import type { SqliteHandle } from "../../../segments/plastron-sqlite/src/index.js";
import { listArticles } from "./article/load.js";
import type { ArticleListEntry, ArticleType } from "./article/types.js";
import { ArticleList } from "./views/ArticleList.js";
import { ArticleEditor } from "./views/ArticleEditor.js";

// Hash-based routing without pulling in plastron-routes — the routing
// surface here is small (4 hashes) and React-resident. plastron-routes
// shines for plastron-driven nav across lazy-loaded segments; the CMS
// shell isn't doing that.
//
// Hashes:
//   #/                      → list view
//   #/new?type=page         → blank editor for a new page
//   #/new?type=newsletter   → blank editor for a new newsletter
//   #/edit/<id>             → editor for an existing article

interface Route {
  view: "list" | "edit" | "new";
  articleId?: number;
  newType?: ArticleType;
}

const parseHash = (h: string): Route => {
  const stripped = h.startsWith("#") ? h.slice(1) : h;
  if (stripped === "" || stripped === "/") return { view: "list" };
  const editMatch = /^\/edit\/(\d+)$/.exec(stripped);
  if (editMatch) return { view: "edit", articleId: Number(editMatch[1]) };
  const newMatch = /^\/new(?:\?type=(page|newsletter))?$/.exec(stripped);
  if (newMatch) {
    return {
      view: "new",
      newType: (newMatch[1] as ArticleType | undefined) ?? "page",
    };
  }
  return { view: "list" };
};

const navTo = (hash: string): void => {
  if (window.location.hash !== hash) window.location.hash = hash;
};

export const Shell = ({ db }: { db: SqliteHandle }): React.ReactElement => {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [articles, setArticles] = useState<ArticleListEntry[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshArticles = useCallback(async () => {
    setArticles(await listArticles(db));
  }, [db]);

  useEffect(() => { void refreshArticles(); }, [refreshArticles]);

  return (
    <div className="cms-shell">
      <aside className="sidebar">
        <h2>plastron-cms</h2>
        <nav>
          <a href="#/" className={route.view === "list" ? "active" : ""}>All articles</a>
          <a href="#/new?type=page">＋ New page</a>
          <a href="#/new?type=newsletter">＋ New newsletter</a>
        </nav>
        <hr />
        <ul className="article-list">
          {articles.map((a) => (
            <li key={a.id}>
              <a href={`#/edit/${a.id}`} className={route.articleId === a.id ? "active" : ""}>
                <span className="badge">{a.type === "page" ? "📄" : "✉"}</span>
                {a.title}
              </a>
            </li>
          ))}
          {articles.length === 0 && <li className="empty">No articles yet.</li>}
        </ul>
      </aside>
      <main className="main-pane">
        {route.view === "list" && (
          <ArticleList
            articles={articles}
            onPick={(id) => navTo(`#/edit/${id}`)}
            onNew={(type) => navTo(`#/new?type=${type}`)}
          />
        )}
        {(route.view === "edit" || route.view === "new") && (
          <ArticleEditor
            db={db}
            mode={route.view}
            articleId={route.articleId}
            newType={route.newType ?? "page"}
            onSaved={(id) => {
              void refreshArticles();
              if (route.view === "new") navTo(`#/edit/${id}`);
            }}
            onDeleted={() => {
              void refreshArticles();
              navTo("#/");
            }}
          />
        )}
      </main>
    </div>
  );
};
