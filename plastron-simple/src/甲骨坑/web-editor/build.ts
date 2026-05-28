import type { DehydratedCel, Fn, Key, State, 甲骨 } from "../../types/index.js";
import { resolveFn } from "../../kernel/resolve-fn.js";

// ============================================================================
// web-editor — a live cel playground app. Left half: a textarea showing the
// user's app source as JSON ({ manifest, segment }); right half: a preview
// pane that the user's app paints into. "Run" parses the JSON, hydrates the
// segment (name "userapp"), and the kernel's cascade + painter do the rest.
//
// Two preset examples ship with the editor (Counter, Weather) so a learner
// can see "an app is just cels + a view" in two flavors:
//   • Counter — pure local state: a value cel `count` + a (dispatch stdlib.inc
//     "count") onClick. No async, no external services.
//   • Weather — async I/O: an editable `city` input + a "Fetch" button that
//     dispatches stdlib.fetch-weather, which awaits a CORS-enabled API and
//     `set`s the `weather` cel. Shows hydrate-is-async in action.
//
// The "cel that attaches DOM items to the preview root" — the one the user
// asked be made explicit — is the user-app's `mount` ValueCel, value
// "#webedit-preview". The painter only writes vnodes into the element named
// by that cel; flip its value and the same userapp paints elsewhere. Both
// preset examples include this cel verbatim, labelled in the JSON comments.
//
// Same factory + installActions shape as notepad/sheet:
//   • buildWebEditor(opts) returns a pure-data role:"application" segment
//   • installWebEditorActions(state) registers run/load-*/save/load and a
//     small stdlib (stdlib.inc/dec/fetch-weather) the example apps dispatch.
// ============================================================================

export interface BuildWebEditorOpts {
  /** Initial textarea source (default: COUNTER_EXAMPLE). */
  source?: string;
  /** Mount selector for the editor view (default "#webedit"). */
  mount?: string;
  /** File-store path Save/Load use (default "webedit.json"). */
  path?: string;
  /** Segment name to tag the editor's cels with (default "web-editor"). */
  segment?: string;
}

// ── preset example apps the user can load into the textarea ─────────────────
//
// Each example is a JSON document of shape { manifest, segment } that
// webedit.run hydrates as the "userapp" segment. The shared rules:
//   • role: "application", deps html-template-parser + plastron-dom
//   • a `mount` ValueCel with v: "#webedit-preview" — the cel that attaches
//     the rendered DOM to the editor's preview pane
//   • a `view` FormulaCel (parser html-template, channel plastron-dom.paint,
//     schema render-spec) whose template references the other cels by
//     ASCII-aliased inputMap entries
//   • interactivity via (dispatch <stdlib-key> <argKey>?) action slots

export const COUNTER_EXAMPLE = JSON.stringify({
  manifest: { name: "userapp", version: "0.0.1",
              dependencies: ["html-template-parser", "plastron-dom"], role: "application" },
  segment: {
    name: "userapp",
    cels: [
      { key: "count", celType: "ValueCel",
        metadata: { key: "count", segment: "userapp" }, v: 0 },
      // ↓ THE MOUNT CEL — attaches the userapp's vnodes to #webedit-preview.
      { key: "mount", celType: "ValueCel",
        metadata: { key: "mount", segment: "userapp" }, v: "#webedit-preview" },
      { key: "view", celType: "FormulaCel",
        metadata: { key: "view", segment: "userapp",
                    parser: "html-template", schema: "render-spec",
                    channel: ["plastron-dom.paint"],
                    inputMap: { mount: "mount", count: "count" } },
        f: '<div class="counter"><h2>Counter</h2>'
         + '<button onClick={{(dispatch "stdlib.inc" "count")}}>+1</button>'
         + '<button onClick={{(dispatch "stdlib.dec" "count")}}>-1</button>'
         + '<span class="count">{{count}}</span></div>' },
    ],
  },
}, null, 2);

export const WEATHER_EXAMPLE = JSON.stringify({
  manifest: { name: "userapp", version: "0.0.1",
              dependencies: ["html-template-parser", "plastron-dom"], role: "application" },
  segment: {
    name: "userapp",
    cels: [
      { key: "city", celType: "ValueCel",
        metadata: { key: "city", segment: "userapp" }, v: "Paris" },
      { key: "weather", celType: "ValueCel",
        metadata: { key: "weather", segment: "userapp" }, v: "" },
      // Controlled-input binding for the city field — same pattern as notepad.
      { key: "city-binding", celType: "ValueCel",
        metadata: { key: "city-binding", segment: "userapp" },
        v: { set: "city", extract: "value" } },
      // ↓ THE MOUNT CEL — attaches the userapp's vnodes to #webedit-preview.
      { key: "mount", celType: "ValueCel",
        metadata: { key: "mount", segment: "userapp" }, v: "#webedit-preview" },
      { key: "view", celType: "FormulaCel",
        metadata: { key: "view", segment: "userapp",
                    parser: "html-template", schema: "render-spec",
                    channel: ["plastron-dom.paint"],
                    inputMap: { mount: "mount", city: "city", weather: "weather",
                                binding: "city-binding" } },
        f: '<div class="weather"><h2>Weather</h2>'
         + '<label>city <input value={{city}} onInput={{binding}} /></label>'
         + '<button onClick={{(dispatch "stdlib.fetch-weather")}}>Fetch</button>'
         + '<pre class="out">{{weather}}</pre></div>' },
    ],
  },
}, null, 2);

// ── editor view template ────────────────────────────────────────────────────
//
// The editor is itself a plastron app: a left textarea bound to webedit.source
// via the shared { set, extract } event binding, a right preview div whose id
// matches the userapp's mount cel value, a toolbar (Run / Clear / examples /
// Save / Load), and a status line.

const WEBEDIT_VIEW = `<div class="webedit" id="webedit">
  <div class="webedit-toolbar">
    <button class="webedit-run" onClick={{(dispatch webedit.run)}}>▶ Run</button>
    <button class="webedit-clear" onClick={{(dispatch webedit.clear)}}>Clear</button>
    <span class="sep">·</span>
    <button onClick={{(dispatch webedit.load-counter)}}>Load Counter</button>
    <button onClick={{(dispatch webedit.load-weather)}}>Load Weather</button>
    <span class="sep">·</span>
    <button onClick={{(dispatch webedit.save)}}>Save</button>
    <button onClick={{(dispatch webedit.load)}}>Load file</button>
    <span class="webedit-status">{{status}}</span>
  </div>
  <div class="webedit-split">
    <textarea class="webedit-source" rows="20"
              value={{source}} onInput={{binding}}
              spellcheck="false"></textarea>
    <div class="webedit-preview-wrap">
      <div class="webedit-preview-label">preview root: #webedit-preview</div>
      <div id="webedit-preview"></div>
    </div>
  </div>
</div>`;

const value = (key: Key, segment: string, v: unknown): DehydratedCel =>
  ({ key, celType: "ValueCel", metadata: { key, segment }, v } as unknown as DehydratedCel);

/** Build the web-editor application segment. Pure data — the host hydrates it
 *  directly. Same factory shape as buildNotepad / buildSheet. */
export const buildWebEditor = (
  opts: BuildWebEditorOpts = {},
): 甲骨 & { version: string; role: "application"; dependencies: Key[] } => {
  const segment = opts.segment ?? "web-editor";
  const cels: DehydratedCel[] = [
    value("webedit.source", segment, opts.source ?? COUNTER_EXAMPLE),
    value("webedit.mount", segment, opts.mount ?? "#webedit"),
    value("webedit.path", segment, opts.path ?? "webedit.json"),
    value("webedit.status", segment, "ready"),
    value("webedit.input-binding", segment, { set: "webedit.source", extract: "value" }),
    {
      key: "webedit.view", celType: "FormulaCel",
      metadata: {
        key: "webedit.view", segment,
        parser: "html-template", schema: "render-spec",
        channel: ["plastron-dom.paint"],
        inputMap: {
          source: "webedit.source", mount: "webedit.mount",
          binding: "webedit.input-binding", status: "webedit.status",
        },
      },
      f: WEBEDIT_VIEW,
    } as unknown as DehydratedCel,
  ];
  return {
    name: segment, version: "0.0.1", role: "application",
    dependencies: ["html-template-parser", "plastron-dom"],
    cels,
  };
};

// ── runtime actions ─────────────────────────────────────────────────────────
//
// The editor's own actions (run/load-*/save/load) plus a small `stdlib.*` the
// example apps dispatch. Same install pattern as notepad.

const get = (state: State, key: Key): unknown => state.cels.get(key)?.v;
const sourceText = (state: State): string => (get(state, "webedit.source") as string) ?? "";
const editPath = (state: State): string => (get(state, "webedit.path") as string) ?? "webedit.json";

interface UserAppDoc { manifest: unknown; segment: unknown; }
const parseSource = (raw: string): UserAppDoc => {
  const doc = JSON.parse(raw) as UserAppDoc;
  if (!doc || typeof doc !== "object" || !doc.manifest || !doc.segment) {
    throw new Error("expected { manifest, segment }");
  }
  return doc;
};

/** Run the JSON in webedit.source as a "userapp" segment: flush any prior
 *  userapp, hydrate the new one, runCycle, drain the paint channel. Errors
 *  surface in webedit.status; nothing crashes. */
const makeRun = (): Fn => async (state: State) => {
  const setFn = resolveFn(state, "set");
  const flush = resolveFn(state, "flush");
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  const drain = resolveFn(state, "drain");
  if (!setFn || !hydrate || !runCycle) return state;
  try {
    const doc = parseSource(sourceText(state));
    // Tear down any prior userapp so re-runs are clean.
    if (state.segments.has("userapp") && flush) await flush(state, "userapp");
    await hydrate(state, [doc.segment], [doc.manifest]);
    await runCycle(state);
    if (drain) await drain(state, "plastron-dom.paint");
    await setFn(state, "webedit.status", "ran ✓");
  } catch (e) {
    await setFn(state, "webedit.status", `error: ${(e as Error).message}`);
  }
  return state;
};

const makeLoad = (snippet: string): Fn => async (state: State) => {
  const setFn = resolveFn(state, "set");
  if (setFn) await setFn(state, "webedit.source", snippet);
  return state;
};

const makeClear = (): Fn => async (state: State) => {
  const setFn = resolveFn(state, "set");
  if (setFn) await setFn(state, "webedit.source", "");
  return state;
};

const makeSave = (): Fn => async (state: State) => {
  const writeText = resolveFn(state, "fs.writeText");
  if (!writeText) return state;
  await writeText(editPath(state), sourceText(state));
  const setFn = resolveFn(state, "set");
  if (setFn) await setFn(state, "webedit.status", "saved ✓");
  return state;
};

const makeLoadFile = (): Fn => async (state: State) => {
  const readText = resolveFn(state, "fs.readText");
  const exists = resolveFn(state, "fs.exists");
  const setFn = resolveFn(state, "set");
  if (!readText || !setFn) return state;
  const path = editPath(state);
  if (exists && !(await exists(path))) {
    await setFn(state, "webedit.status", "no file at " + path);
    return state;
  }
  await setFn(state, "webedit.source", await readText(path));
  await setFn(state, "webedit.status", "loaded ✓");
  return state;
};

// ── stdlib actions the example apps dispatch ────────────────────────────────

/** stdlib.inc — `(dispatch "stdlib.inc" "<cel-key>")` adds 1 to a value cel. */
const makeInc = (delta: number): Fn => async (state: State, key: unknown) => {
  const setFn = resolveFn(state, "set");
  if (!setFn || typeof key !== "string") return state;
  const cur = Number(get(state, key) ?? 0);
  await setFn(state, key, (Number.isFinite(cur) ? cur : 0) + delta);
  return state;
};

/** stdlib.fetch-weather — no arg; reads cel `city`, writes cel `weather`.
 *  Uses Open-Meteo's free no-key geocoding+forecast over CORS-enabled https.
 *  Errors land in the `weather` cel as a readable string (trap-as-value). */
const makeFetchWeather = (): Fn => async (state: State) => {
  const setFn = resolveFn(state, "set");
  if (!setFn) return state;
  const city = String(get(state, "city") ?? "Paris");
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`,
    ).then((r) => r.json() as Promise<{ results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> }>);
    const hit = geo.results?.[0];
    if (!hit) { await setFn(state, "weather", `no match for "${city}"`); return state; }
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,wind_speed_10m`,
    ).then((r) => r.json() as Promise<{ current?: { temperature_2m?: number; wind_speed_10m?: number } }>);
    const cur = wx.current ?? {};
    await setFn(state, "weather",
      `${hit.name}${hit.country ? ", " + hit.country : ""}\n` +
      `temperature: ${cur.temperature_2m}°C\nwind: ${cur.wind_speed_10m} m/s`);
  } catch (e) {
    await setFn(state, "weather", `fetch error: ${(e as Error).message}`);
  }
  return state;
};

/** Register the editor's actions and the example-apps' stdlib against the live
 *  state. Idempotent. */
export const installWebEditorActions = async (
  state: State, opts: { segment?: string } = {},
): Promise<State> => {
  const register = resolveFn(state, "registerLambda")!;
  const segment = opts.segment ?? "web-editor";
  const reg = (key: string, fn: Fn) =>
    register(state, { key, segment, kind: "native", locked: true, fn });

  await reg("webedit.run", makeRun());
  await reg("webedit.clear", makeClear());
  await reg("webedit.load-counter", makeLoad(COUNTER_EXAMPLE));
  await reg("webedit.load-weather", makeLoad(WEATHER_EXAMPLE));
  await reg("webedit.save", makeSave());
  await reg("webedit.load", makeLoadFile());

  // stdlib.* — generic verbs the user-app templates dispatch.
  await reg("stdlib.inc", makeInc(+1));
  await reg("stdlib.dec", makeInc(-1));
  await reg("stdlib.fetch-weather", makeFetchWeather());

  return state;
};
