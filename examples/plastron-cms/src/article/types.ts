export type ArticleType = "page" | "newsletter";

export interface ArticleMeta {
  id: number;
  slug: string;
  title: string;
  type: ArticleType;
}

export interface ArticleListEntry extends ArticleMeta {
  createdAt: string;
  updatedAt: string;
}
