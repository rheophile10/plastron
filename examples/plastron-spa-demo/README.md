# plastron SPA demo

A Vite-built single-page app showing a plastron runtime driving a real
DOM. Two segments wired into a nav-driven shell:

- **Counter** — click `+1`, the count increments. Demonstrates an
  event-sink cel + a downstream lambda that watches it.
- **Weather** — type a city, click Fetch. Calls Open-Meteo (no API key)
  and renders the result. Demonstrates async I/O via a side-effecting
  lambda that writes back into the graph.

Segments are **lazy-loaded**: the initial bundle ships only the shell.
Clicking a nav button dynamically imports the segment's module (Vite
emits a separate chunk per dynamic import), hydrates its cels, runs a
priming cycle, then switches the view. State survives nav switches —
go to Counter, click +1 a few times, switch to Weather, switch back:
the count is preserved.

## Run

```sh
cd examples/plastron-spa-demo
npm install
npm run dev   # http://localhost:5173
```

### Run from VS Code

Open the repo root as the workspace. The repo's `.vscode/launch.json`
(gitignored, so per-developer) defines three configs for this demo:

- **Plastron SPA Demo (Vite + Chrome)** — starts the dev server,
  watches stdout for the `Local: http://localhost:…` line, then opens
  Chrome with the debugger attached. One click, full devloop.
- **Plastron SPA Demo (Vite, no browser)** — just the dev server.
- **Plastron SPA Demo (Chrome attach)** — opens Chrome at
  `localhost:5173` if a server is already running.

Pick one from the Run dropdown and hit play.

## Architecture

```
plastron kernel  ←  shell hydrates at startup. counter and weather
                     hydrate on first nav click via dynamic import.
                     Each Segment is its own module, its own Vite
                     chunk, its own bundle of cels + fns.

plastron-dom    ←  installDom mounts appTree on `#root` and adds a
                     patch cel per root (just `app` here). The patch
                     cel's value is the JSON-shape Patch the painter
                     applies on the next rAF.

window.__plastronState  — exposed for devtool poking. Try:
                           __plastronState.cels.get("count").v
                           __plastronState.cels.get("weatherData").v
                           __plastronState.cels.get("__plastronDom:patch:app").v
```

### Lazy loading via dispatch bindings

Nav buttons don't write a cel directly — they dispatch:

```ts
el("button", {
  onClick: { dispatch: "shell:navigateTo", payload: "counter" },
}, "Counter")
```

The painter sees a `dispatch` binding and calls
`state.fns.get(binding.dispatch)(state, binding.payload)`. The
`navigateTo` fn (registered in main.ts) does:

```ts
const navigateTo: Fn = async (state, payload) => {
  const target = String(payload);
  if (!loaded.has(target)) {
    const build = await factories[target]();   // dynamic import
    const seg = build(state);
    state.fns.get("hydrate")(state, [seg.segment], [seg.fns]);
    loaded.add(target);
    await state.fns.get("runCycle")(state);    // prime new lambdas
  }
  await state.fns.get("set")(state, "currentView", target);
};
```

Because dispatch fires outside the cycle, it can call hydrate (which
mutates `state.cels` and re-runs precompute) without breaking the
runCycle invariants.

### EventBinding shape

```ts
interface EventBinding {
  set?: string;        // cel key to write
  value?: unknown;     // fixed value, else painter writes EventInfo
  dispatch?: string;   // fn key in state.fns to invoke
  payload?: unknown;   // static payload passed to the dispatch fn
}
```

Both can coexist on a single binding — `set` runs first (sync write),
then `dispatch` (async fn call). For the nav we use `dispatch` only
since the dispatcher itself ends up calling `set`.

### Counter pattern

```ts
{ key: "counterClick",   v: null }                          // event sink
{ key: "count",          l: "counter:incrementOnClick",
                         inputMap: { event: "counterClick" }, v: 0 }
{ key: "counterTree",    l: "counter:renderCounter",
                         inputMap: { count: "count" } }
```

The painter writes a fresh `EventInfo` object to `counterClick` on
every button press. The `incrementOnClick` lambda has a closure
holding `lastEvent`; reference inequality means "a new click landed,"
which is when it bumps the count. Reading `count`'s previous value
inside its own lambda works because the kernel hasn't overwritten
`cel.v` yet at the time the fn runs.

### Weather pattern

The fetch is a side-effecting lambda. Pure-async lambdas would block
the cycle on the await; instead, `weatherFetcher` kicks off the
fetch, immediately returns `null`, and writes intermediate states
(`loading`, `ok`, `error`) to a separate `weatherData` cel via
`state.fns.get("set")`:

```ts
weatherFetcher: ({ city, click }) => {
  if (click === lastClick || click === null) return null;
  lastClick = click;
  setFn(state, "weatherData", { state: "loading", city });
  fetchWeather(city)
    .then(r   => setFn(state, "weatherData", r))
    .catch(e  => setFn(state, "weatherData", { state: "error", message: String(e) }));
  return null;
};
```

This is the canonical "graph-resident UI state with off-graph I/O"
shape — the cel graph stays synchronous and inspectable, the network
call lives in JavaScript-land and reports back via `set`.

## What's not yet here, on purpose

- **Form-input value reconciliation.** The painter writes `value` as
  an HTML attribute, not the DOM property — fast typing won't be
  fought by re-renders, but a programmatic reset of the cel won't
  reach the live input. A `prop:` prefix or a special-case for
  `input.value` would fix it; deferred until needed.
- **Routing.** No URL sync — `currentView` is in-memory only.
- **Unloading segments.** Once hydrated, a segment stays in state.
  The kernel doesn't have a public "remove these cels" API yet, so
  unloading would require something like a `flush(segmentKey)` fn.
