import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import {
  makeListener, attachEvents, applyEventDelta, detachAllListeners,
  applyListenerDelta, diffListenerSpecs, parseSpec,
} from "../dist/甲骨坑/dom/events.js";

// event-registries — per-element + global listener registries and the
// makeListener closure that turns declarative bindings (incl. the new
// { f: source } action form) into real DOM listeners. The kernel ships no
// DOM, so a tiny structural fake stands in for elements / global targets.
// See docs/3-test-design/05-runCycle/event-registries.md.

const userManifest = { name: "user", version: "0.0.1", dependencies: [] };
const tick = () => new Promise((r) => setTimeout(r, 5));

// Minimal event-target fake: tracks attached listeners so leaks are visible.
const fakeTarget = () => {
  const map = new Map(); // type -> Set<fn>
  return {
    map, childNodes: [], nodeType: 1,
    addEventListener(t, fn) { (map.get(t) ?? map.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { map.get(t)?.delete(fn); },
    fire(t, event = {}) { for (const fn of [...(map.get(t) ?? [])]) fn({ type: t, ...event }); },
    liveCount() { let n = 0; for (const s of map.values()) n += s.size; return n; },
  };
};

// ── per-element registry: attach → dispatch → detach, no leaks ──────────────

test("per-element registry attaches, dispatches, and detaches without leaking", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [{ key: "counter", celType: "ValueCel", metadata: { key: "counter", segment: "user" }, v: 0 }],
  }], [userManifest]);
  await precomputeOptional(state);

  const reg = new WeakMap();
  const el = fakeTarget();
  attachEvents(el, { click: { f: '(set "counter" (+ counter 1))' } }, reg, state);
  assert.equal(el.liveCount(), 1, "one listener attached");

  el.fire("click");
  await tick();
  assert.equal(state.cels.get("counter").v, 1, "{f} action ran on dispatch");
  el.fire("click");
  await tick();
  assert.equal(state.cels.get("counter").v, 2, "compiled handler is reused — cumulative effect");

  detachAllListeners(el, reg);
  assert.equal(el.liveCount(), 0, "detach removed the DOM listener (no leak)");
  assert.equal(reg.get(el), undefined, "registry entry cleared");
});

test("applyEventDelta upserts (swap fn) and removes per-element listeners", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "user", cels: [
    { key: "calls", celType: "ValueCel", metadata: { key: "calls", segment: "user" }, v: 0 },
  ] }], [userManifest]);
  await precomputeOptional(state);
  const register = resolveFn(state, "registerLambda");
  let aCount = 0, bCount = 0;
  await register(state, { key: "a", fn: () => { aCount++; }, kind: "custom" });
  await register(state, { key: "b", fn: () => { bCount++; }, kind: "custom" });

  const reg = new WeakMap();
  const el = fakeTarget();
  attachEvents(el, { click: { f: '(dispatch "a")' } }, reg, state);
  el.fire("click");
  assert.equal(aCount, 1);

  // Upsert swaps the click handler; the old one must be detached.
  applyEventDelta(el, { upsert: { click: { f: '(dispatch "b")' } } }, reg, state);
  assert.equal(el.liveCount(), 1, "upsert swaps in place, not stacks");
  el.fire("click");
  assert.equal(aCount, 1, "old handler detached");
  assert.equal(bCount, 1, "new handler attached");

  applyEventDelta(el, { remove: ["click"] }, reg, state);
  assert.equal(el.liveCount(), 0, "remove detached the listener");
  assert.equal(reg.get(el), undefined, "registry entry dropped when empty");
});

// ── { f } binding compiles lazily once per install ──────────────────────────

test("an { f } binding compiles lazily and reuses the cached handler", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "user", cels: [] }], [userManifest]);
  await precomputeOptional(state);
  const register = resolveFn(state, "registerLambda");
  const seen = [];
  await register(state, { key: "rec", fn: (_s, arg) => { seen.push(arg); }, kind: "custom" });

  const listener = makeListener({ f: '(dispatch "rec" 7)' }, state);
  listener({ type: "click" });
  listener({ type: "click" });
  assert.deepEqual(seen, [7, 7], "lazily-compiled action runs on every dispatch");
});

// ── global registry against a mocked target ─────────────────────────────────

test("global registry adds/removes listeners on the named target", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "user", cels: [
    { key: "modal.open", celType: "ValueCel", metadata: { key: "modal.open", segment: "user" }, v: true },
  ] }], [userManifest]);
  await precomputeOptional(state);

  const doc = fakeTarget();
  const resolveTarget = (name) => (name === "document" ? doc : null);
  const reg = new Map();
  const spec = 'document|keydown|(set "modal.open" false)';

  applyListenerDelta([], [spec], reg, state, resolveTarget);
  assert.equal(doc.liveCount(), 1, "listener attached to document");
  assert.ok(reg.has("document|keydown"), "registry keyed by target|event");

  doc.fire("keydown", { key: "Escape" });
  await tick();
  assert.equal(state.cels.get("modal.open").v, false, "global listener action ran");

  applyListenerDelta([spec], [], reg, state, resolveTarget);
  assert.equal(doc.liveCount(), 0, "listener removed when spec drops out");
  assert.equal(reg.size, 0, "registry entry cleared");
});

test("global registry conflict policy is first-wins for same target|event", () => {
  const state = createInitialState();
  const doc = fakeTarget();
  const reg = new Map();
  const specs = ['document|keydown|(dispatch "a")', 'document|keydown|(dispatch "b")'];
  applyListenerDelta([], specs, reg, state, (n) => (n === "document" ? doc : null));
  assert.equal(doc.liveCount(), 1, "only the first spec for a target|event is attached");
  assert.equal(reg.size, 1);
  assert.equal(reg.get("document|keydown").spec, specs[0], "first wins");
});

test("diffListenerSpecs / parseSpec helpers", () => {
  assert.deepEqual(
    diffListenerSpecs(["x", "y"], ["y", "z"]),
    { add: ["z"], remove: ["x"] },
  );
  // source may itself contain '|' — only the first two separators are structural.
  assert.deepEqual(
    parseSpec("document|keydown|(if (== event.key \"a|b\") (set x true))"),
    { target: "document", event: "keydown", source: '(if (== event.key "a|b") (set x true))' },
  );
});

// ── string-list schema is memoSafe: suppression preserves the array ref ─────

test("string-list schema suppresses a recompute that yields equal contents", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "mkspecs", fn: () => ["document|keydown|(set \"x\" true)"], kind: "custom" });
  await hydrate(state, [{ name: "user", cels: [
    { key: "trigger", celType: "ValueCel", metadata: { key: "trigger", segment: "user" }, v: 0 },
    {
      key: "specs", celType: "FormulaCel",
      metadata: { key: "specs", segment: "user", parser: "f", schema: "string-list", inputMap: { trigger: "trigger" } },
      f: "(mkspecs trigger)",
    },
  ] }], [userManifest]);
  await precomputeOptional(state);

  const runCycle = resolveFn(state, "runCycle");
  const set = resolveFn(state, "set");
  await runCycle(state);
  const ref1 = state.cels.get("specs").v;
  assert.deepEqual(ref1, ["document|keydown|(set \"x\" true)"]);

  // Recompute (mkspecs returns a fresh, equal array). string-list isChanged
  // sees equal contents → suppression keeps the prior reference.
  await set(state, "trigger", 1);
  assert.strictEqual(state.cels.get("specs").v, ref1, "ref preserved when contents unchanged");
});
