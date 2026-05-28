import { test } from "bun:test";
import assert from "node:assert/strict";

// web-editor — a live cel playground app. Cels on the left (a JSON textarea),
// preview on the right (#webedit-preview). Run parses the JSON and hydrates a
// "userapp" segment; the userapp's mount cel attaches its vnodes to the
// preview root. Two preset examples ship: Counter (pure local) and Weather
// (async fetch via stdlib.fetch-weather).
//
// This suite exercises the cel-level behavior end-to-end without a DOM —
// the painter is exercised in the browser harness; here we verify that
// buildWebEditor + installWebEditorActions wire the source/run/load/stdlib
// loop correctly. (DOM tests of the rendered editor live in the example app's
// harness, similar to pictograph.)

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-webedit";

const {
  createInitialState, precomputeOptional, resolveFn,
  buildWebEditor, installWebEditorActions, COUNTER_EXAMPLE, WEATHER_EXAMPLE,
} = await import("../dist/index.js");

const v = (state, key) => state.cels.get(key)?.v;
const call = (state, key, ...args) => resolveFn(state, key)(state, ...args);

const bootEditor = async (opts) => {
  const state = createInitialState();
  const seg = buildWebEditor(opts);
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await installWebEditorActions(state);
  await precomputeOptional(state);
  return state;
};

// ── 1. boot: the editor's cels install and default source loads ─────────────

test("buildWebEditor installs the editor cels with the COUNTER_EXAMPLE default", async () => {
  const state = await bootEditor();
  assert.equal(v(state, "webedit.mount"), "#webedit");
  assert.equal(v(state, "webedit.status"), "ready");
  // Default source is the counter example.
  const src = v(state, "webedit.source");
  assert.match(src, /Counter/);
  assert.match(src, /stdlib\.inc/);
  // The mount cel that attaches the userapp's DOM to the preview root is
  // present in the bundled JSON (the cel the user asked be made explicit).
  assert.match(src, /"#webedit-preview"/);
});

test("buildWebEditor honors a custom source via opts", async () => {
  const state = await bootEditor({ source: "{}" });
  assert.equal(v(state, "webedit.source"), "{}");
});

// ── 2. examples: the two preset JSONs declare role:application + mount ──────

test("COUNTER_EXAMPLE is a well-formed userapp doc with the mount cel", () => {
  const doc = JSON.parse(COUNTER_EXAMPLE);
  assert.equal(doc.manifest.name, "userapp");
  assert.equal(doc.manifest.role, "application");
  const mount = doc.segment.cels.find((c) => c.key === "mount");
  assert.equal(mount.v, "#webedit-preview"); // THE preview-root attachment cel
  assert.ok(doc.segment.cels.find((c) => c.key === "count"));
  assert.ok(doc.segment.cels.find((c) => c.key === "view"));
});

test("WEATHER_EXAMPLE declares city, weather, and the same mount cel", () => {
  const doc = JSON.parse(WEATHER_EXAMPLE);
  assert.equal(doc.manifest.name, "userapp");
  const mount = doc.segment.cels.find((c) => c.key === "mount");
  assert.equal(mount.v, "#webedit-preview");
  assert.ok(doc.segment.cels.find((c) => c.key === "city"));
  assert.ok(doc.segment.cels.find((c) => c.key === "weather"));
});

// ── 3. webedit.run: parse source → hydrate userapp ──────────────────────────

test("webedit.run hydrates the counter userapp into state", async () => {
  const state = await bootEditor();
  await call(state, "webedit.run");
  // The userapp manifest landed.
  assert.equal(state.segments.get("userapp")?.role, "application");
  // The mount and count cels exist with their declared values.
  assert.equal(v(state, "mount"), "#webedit-preview");
  assert.equal(v(state, "count"), 0);
  // Status reflects the successful run.
  assert.equal(v(state, "webedit.status"), "ran ✓");
});

test("webedit.run surfaces a parse error in webedit.status without crashing", async () => {
  const state = await bootEditor({ source: "{ not valid json" });
  await call(state, "webedit.run");
  assert.match(v(state, "webedit.status"), /^error:/);
});

// ── 4. stdlib.inc / stdlib.dec drive the counter through real dispatches ───

test("stdlib.inc increments the named cel; stdlib.dec decrements it", async () => {
  const state = await bootEditor();
  await call(state, "webedit.run");
  // simulate the counter's onClick=(dispatch "stdlib.inc" "count") three times
  await call(state, "stdlib.inc", "count");
  await call(state, "stdlib.inc", "count");
  await call(state, "stdlib.inc", "count");
  assert.equal(v(state, "count"), 3);
  await call(state, "stdlib.dec", "count");
  assert.equal(v(state, "count"), 2);
});

// ── 5. webedit.load-weather + re-run swaps the userapp cleanly ──────────────

test("webedit.load-weather → run flushes counter cels and installs weather cels", async () => {
  const state = await bootEditor();
  await call(state, "webedit.run");                  // counter live
  assert.equal(v(state, "count"), 0);

  await call(state, "webedit.load-weather");
  assert.match(v(state, "webedit.source"), /Weather/);

  await call(state, "webedit.run");
  // count is gone (flushed); city + weather replaced it.
  assert.equal(state.cels.has("count"), false);
  assert.equal(v(state, "city"), "Paris");
  assert.equal(typeof v(state, "weather"), "string");
  assert.equal(v(state, "webedit.status"), "ran ✓");
});

// ── 6. webedit.clear empties the source ─────────────────────────────────────

test("webedit.clear empties webedit.source", async () => {
  const state = await bootEditor();
  await call(state, "webedit.clear");
  assert.equal(v(state, "webedit.source"), "");
});
