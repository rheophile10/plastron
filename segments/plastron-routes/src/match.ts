import type { Fn, LambdaKey, Segment } from "../../../plastron/src/types/index.js";

// ============================================================================
// Pattern matcher — pure functions, no kernel dependency.
//
// Pattern syntax: literal segments + `:name` parameters separated by `/`.
//   "/users/:id"            matches "/users/42"        params { id: "42" }
//   "/users/:id/posts/:pid" matches "/users/42/posts/7" params { id: "42", pid: "7" }
//   "/"                     matches "/" only.
//
// Compile each pattern once at install time into a regex + ordered param-name
// list. Match each candidate path by iterating compiled routes in declaration
// order; first hit wins. Trailing slashes are normalized off.
//
// Query strings (?key=val&...) are split off before pattern matching and
// parsed via URLSearchParams. They never participate in pattern matching;
// they only flow through onto the resulting RouteMatch.
//
// Out of scope (v1): catch-all "*", optional segments ":id?", regex
// constraints ":id(\\d+)", named groups across slashes (none of these
// have a consumer yet).
// ============================================================================

export type SegmentBundle = { segment: Segment; fns: Map<LambdaKey, Fn> };

export interface RouteEntry {
  /** Pattern string with `:param` placeholders, e.g. "/users/:id". */
  pattern: string;
  /** View key written to route:view when this route matches and (if needed)
   *  its segment has finished loading. */
  view: string;
  /** Optional dynamic loader. When the matched route has a `load`, the
   *  loader channel handler awaits it before flipping route:view. Loaded
   *  bundles are cached by view key — repeat matches don't reload. */
  load?: () => Promise<SegmentBundle>;
}

export interface RouteMatch {
  pattern: string;
  view: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface CompiledRoute {
  entry: RouteEntry;
  regex: RegExp;
  paramNames: string[];
}

const SEGMENT_RE = /\/:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Compile a route pattern into a regex with capture groups for each
 *  `:param`. The regex is anchored, matches the path component only
 *  (caller strips the query first). */
const compileOne = (entry: RouteEntry): CompiledRoute => {
  const paramNames: string[] = [];
  const escaped = entry.pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(SEGMENT_RE, (_match, name: string) => {
    paramNames.push(name);
    return "/([^/]+)";
  });
  const regex = new RegExp(`^${body}$`);
  return { entry, regex, paramNames };
};

export const compileRoutes = (routes: RouteEntry[]): CompiledRoute[] => {
  const seen = new Set<string>();
  const out: CompiledRoute[] = [];
  for (const r of routes) {
    if (seen.has(r.view)) {
      throw new Error(
        `plastron-routes: duplicate view "${r.view}" — each route entry must have a unique view key.`,
      );
    }
    seen.add(r.view);
    out.push(compileOne(r));
  }
  return out;
};

/** Strip the leading `#` if present, normalize trailing slash (except for
 *  the root "/"), and split off the query string. */
const splitPath = (raw: string): { path: string; query: Record<string, string> } => {
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  const fallback = stripped === "" ? "/" : stripped;
  const qIdx = fallback.indexOf("?");
  const pathPart = qIdx === -1 ? fallback : fallback.slice(0, qIdx);
  const queryPart = qIdx === -1 ? "" : fallback.slice(qIdx + 1);
  const path = pathPart.length > 1 && pathPart.endsWith("/")
    ? pathPart.slice(0, -1)
    : pathPart;
  const query: Record<string, string> = {};
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    params.forEach((v, k) => { query[k] = v; });
  }
  return { path, query };
};

export const matchRoute = (
  raw: string,
  compiled: CompiledRoute[],
): RouteMatch | null => {
  const { path, query } = splitPath(raw);
  for (const route of compiled) {
    const m = route.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]!] = decodeURIComponent(m[i + 1]!);
    }
    return {
      pattern: route.entry.pattern,
      view: route.entry.view,
      params,
      query,
    };
  }
  return null;
};

/** Stable key used for change suppression on the route:match cel.
 *  Same view + params + query → same key → loader skips re-firing. */
export const matchKey = (m: RouteMatch | null): string => {
  if (m === null) return "\0miss";
  return `${m.view}\0${JSON.stringify(m.params)}\0${JSON.stringify(m.query)}`;
};
