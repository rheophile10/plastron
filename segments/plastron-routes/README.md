# `plastron-routes`

A hash-based URL router for plastron. Three pieces:

1. **A declarative route table** — patterns with `:param` placeholders,
   each entry naming the view key to switch to and (optionally) a
   dynamic-import loader for that view's segment.
2. **Three router cels** — `route:hash` (data, mirrors
   `window.location.hash`), `route:match` (lambda, derives a
   `RouteMatch` from the hash), and `route:view` (data, the active
   view key — set by the loader after the segment finishes loading).
3. **A loader channel** bound to `route:match`. When the match
   changes, the channel handler awaits the matched route's loader (if
   any), hands the resulting bundle to `hydrate`, runs a cycle, and
   sets `route:view`. Refresh on a deep link lazy-loads the right
   segment from scratch; the previous view stays mounted until the
   new one is ready.

```
window.location.hash ──hashchange──► route:hash
                                         │
                                         ▼
                                    route:match  ──channel──► loader handler
                                         │                         │
                                         │                    dynamic-import
                                         │                    → hydrate
                                         │                    → runCycle
                                         ▼                         │
                                    route:view  ◄─ set ────────────┘
```

## Usage

```ts
import { createInitialState } from "plastron";
import { installDom } from "plastron-dom";
import { installRouter } from "plastron-routes";

const state = createInitialState();
const hydrate = state.fns.get("hydrate")!;
const runCycle = state.fns.get("runCycle")!;

// Hydrate your app shell; reference `route:view` from its render lambda.
hydrate(state, [shellSegment], [shellFns]);

const router = installRouter(state, {
  routes: [
    { pattern: "/", view: "home" },
    { pattern: "/users/:id", view: "user",
      load: () => import("./segments/user.js").then(m => m.userSegment) },
    { pattern: "/posts/:id/comments/:cid", view: "comment",
      load: () => import("./segments/comment.js").then(m => m.commentSegment) },
  ],
  fallback: "home",
});

await runCycle(state);

const dom = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});
await runCycle(state);
dom.channel.drain();

// Programmatic navigation:
router.navigate("/users/42");

// Teardown:
router.dispose();                                    // detach listener
state.fns.get("flush")(state, "plastronRoutes");     // remove cels + channel
```

## Route patterns

```ts
"/"                            // matches "/" only
"/users/:id"                   // params { id: "42" } for "/users/42"
"/posts/:pid/comments/:cid"    // multiple params
```

`:name` captures one path segment (no slashes). Trailing slashes are
normalized off. Query strings (`?tab=info`) are split off and surfaced
as `match.query: Record<string, string>`. They never participate in
pattern matching.

Out of scope (v1): catch-all `*`, optional segments `:id?`, regex
constraints `:id(\\d+)`, named routes, nested routes, route guards.

## `RouteMatch`

```ts
interface RouteMatch {
  pattern: string;                       // the matched RouteEntry.pattern
  view:    string;                       // the matched RouteEntry.view
  params:  Record<string, string>;       // decoded :param captures
  query:   Record<string, string>;       // parsed ?key=val pairs
}
```

`route:match.v` is `RouteMatch | null` (null on miss). Read it from a
downstream lambda to drive view-conditional rendering, or read
`route:view` directly for the simpler case.

## Change suppression

`route:match` carries an `_isChanged` that compares
`view + params + query` rather than reference. Re-firing the loader on
identical re-matches (the active link clicked again, an unrelated cel
write that didn't change the hash) is a no-op.

## Why hash-based

Hash hrefs (`<a href="#/foo">`) navigate without a page reload natively
on every browser, work on static hosts and `file://`, and survive
GitHub Pages without rewrites. The trade-off is the visible `#` in the
URL. History-API mode (clean URLs + click interception + server
cooperation) is a v2 concern.

## Multiple routers

Pass `options.channelKey` to namespace a second router in the same
state. The match lambda key (`plastronRoutes:match`) and the cel keys
(`route:hash`, `route:match`, `route:view`) are fixed — multi-router
support beyond a second channel is a future task.
