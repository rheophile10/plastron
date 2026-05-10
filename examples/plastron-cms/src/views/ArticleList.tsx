import type { ArticleListEntry, ArticleType } from "../article/types.js";

export const ArticleList = ({ articles, onPick, onNew }: {
  articles: ArticleListEntry[];
  onPick: (id: number) => void;
  onNew: (type: ArticleType) => void;
}): React.ReactElement => {
  return (
    <div className="article-list-view">
      <header>
        <h1>Articles</h1>
        <div className="actions">
          <button onClick={() => onNew("page")}>＋ New page</button>
          <button onClick={() => onNew("newsletter")}>＋ New newsletter</button>
        </div>
      </header>
      {articles.length === 0 ? (
        <p className="empty">
          No articles yet. Create your first one with the buttons above.
        </p>
      ) : (
        <table className="article-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {articles.map((a) => (
              <tr key={a.id}>
                <td>{a.title}</td>
                <td>{a.type}</td>
                <td>{new Date(a.updatedAt + "Z").toLocaleString()}</td>
                <td>
                  <button onClick={() => onPick(a.id)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
