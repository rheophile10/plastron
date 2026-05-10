import type { Segment } from "../../../../plastron/src/index.js";

// Boilerplate for a new "page" article. Three content cels (title,
// subtitle, body) and a "view" cel that runs a render lambda producing
// a VNode tree. The host calls installDom with `roots: { main: { ...,
// cel: "view" }}`, which stamps cel.schema with vnodeSchema and binds
// the patch cel's channel — so we don't need to set schema here.
export const buildNewPageSegment = (title = "Untitled page"): Segment => ({
  key: "article",
  cels: [
    { key: "title",    v: title,                segment: "article" },
    { key: "subtitle", v: "",                   segment: "article" },
    { key: "body",     v: "Write something.",   segment: "article" },
    {
      key: "view",
      l: "renderPage",
      inputMap: { title: "title", subtitle: "subtitle", body: "body" },
      segment: "article",
    },
  ],
});
