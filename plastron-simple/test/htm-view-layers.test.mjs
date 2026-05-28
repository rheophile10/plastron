import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// htm-view-layers — the html-template / html-template-ref FormulaCel
// parsers turn HTML-shaped templates with {{…}} interpolation into a
// render-spec ({ vnode, mount, listeners }). Interpolation bodies are the
// kernel's S-expression formula language; the slot decides how the value
// is used (text / attribute / event). See
// docs/3-test-design/05-runCycle/htm-view-layers.md.

const userManifest = { name: "user", version: "0.0.1", dependencies: [] };

// js-common-schema isn't booted into the kernel, so — like the
// execution-hooks tests — we ship minimal memoSafe primitive schemas the
// view inputs declare. memoSafe: true is what lets the view cel's L1 cache
// install. (`render-spec` / `vnode` / `string-list` already ship memoSafe
// in the html-template-parser segment.)
const mkSchema = (key, type) => ({
  key, celType: "SchemaCel", metadata: { key, segment: "vschemas" },
  v: { key, zod: { type }, protocols: {}, memoSafe: true },
});
const schemasSeg = {
  name: "vschemas", version: "0.0.1", dependencies: [],
  cels: [mkSchema("s", "string"), mkSchema("n", "number"), mkSchema("b", "boolean")],
};
const schemasManifest = { name: "vschemas", version: "0.0.1", dependencies: [] };

// Small view-stdlib the worked example leans on (the kernel ships only the
// arithmetic builtins). Registered as lambdas so formulas resolve them as
// fn heads through the cel registry.
const registerStdlib = async (state) => {
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "toUpper", fn: (s) => String(s).toUpperCase(), kind: "custom" });
  await register(state, { key: "concat",  fn: (...a) => a.map(String).join(""), kind: "custom" });
  await register(state, { key: "if",      fn: (c, a, b) => (c ? a : b), kind: "custom" });
};

// Walk a vnode subtree and concatenate its text-node content.
const textOf = (v) => {
  if (!v) return "";
  if (v.type === "text") return v.text;
  return (v.children ?? []).map(textOf).join("");
};
const childByTag = (v, tag) => (v.children ?? []).find((c) => c.type === "el" && c.tag === tag);

// ── 1. inline html-template: auto-wires interpolation deps ──────────────────

test("html-template auto-wires interpolation deps into inputMap", async () => {
  const state = createInitialState();
  await registerStdlib(state);
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [schemasSeg, {
    name: "user",
    cels: [
      { key: "user.name", celType: "ValueCel", metadata: { key: "user.name", segment: "user", schema: "s" }, v: "bob" },
      {
        key: "view", celType: "FormulaCel",
        metadata: { key: "view", segment: "user", parser: "html-template", inputMap: { name: "user.name" } },
        f: "<p>{{(toUpper name)}}</p>",
      },
    ],
  }], [schemasManifest, userManifest]);
  await precomputeOptional(state);

  const im = state.cels.get("view").metadata.inputMap;
  assert.equal(im.name, "user.name", "explicit input preserved");
  assert.equal(im.toUpper, "toUpper", "fn head auto-wired");

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  const spec = state.cels.get("view").v;
  assert.equal(spec.vnode.tag, "p");
  assert.equal(textOf(spec.vnode), "BOB");
  assert.deepEqual(spec.listeners, []);
});

// ── 2. worked example: greeting + counter + input + conditional modal ───────

const bootWorkedExample = async () => {
  const state = createInitialState();
  await registerStdlib(state);
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [schemasSeg, {
    name: "user",
    cels: [
      { key: "user.name",        celType: "ValueCel", metadata: { key: "user.name", segment: "user", schema: "s" }, v: "World" },
      { key: "app.count",        celType: "ValueCel", metadata: { key: "app.count", segment: "user", schema: "n" }, v: 0 },
      { key: "app.theme.color",  celType: "ValueCel", metadata: { key: "app.theme.color", segment: "user", schema: "s" }, v: "#0066cc" },
      { key: "app.modal.open",   celType: "ValueCel", metadata: { key: "app.modal.open", segment: "user", schema: "b" }, v: false },
      { key: "app.incrementStep",celType: "ValueCel", metadata: { key: "app.incrementStep", segment: "user", schema: "n" }, v: 1 },
      { key: "app.mount",        celType: "ValueCel", metadata: { key: "app.mount", segment: "user", schema: "s" }, v: "#root" },
      {
        key: "app.template", celType: "ValueCel",
        metadata: { key: "app.template", segment: "user", schema: "s" },
        v: [
          '<section style={{(concat "color: " theme)}}>',
          "\t<h1>Hello, {{uppercased}}!</h1>",
          "\t<p>Count: {{count}} (doubled: {{doubled}})</p>",
          "\t<button onClick={{incrementBinding}}>+{{step}}</button>",
          '\t<input value={{name}} onInput={{(bindValue "user.name")}} />',
          "\t{{modalContent}}",
          "</section>",
        ],
      },
      {
        key: "app.modal.template", celType: "ValueCel",
        metadata: { key: "app.modal.template", segment: "user", schema: "s" },
        // A ValueCel passed as a value (not `f`) isn't auto-joined, so this
        // sub-template is authored as a single string.
        v: [
          '<div class="modal" role="dialog">',
          "\t<p>Are you sure?</p>",
          "\t<button onClick={{(set app.modal.open false)}}>Close</button>",
          "</div>",
        ].join("\n"),
      },
      {
        key: "app.uppercased", celType: "FormulaCel",
        metadata: { key: "app.uppercased", segment: "user", parser: "f", schema: "s", inputMap: { name: "user.name" } },
        f: "(toUpper name)",
      },
      {
        key: "app.doubled", celType: "FormulaCel",
        metadata: { key: "app.doubled", segment: "user", parser: "f", schema: "n", inputMap: { count: "app.count" } },
        f: "(* count 2)",
      },
      {
        key: "app.incrementBinding", celType: "FormulaCel",
        metadata: { key: "app.incrementBinding", segment: "user", parser: "f", schema: "s", inputMap: { step: "app.incrementStep" } },
        f: '(concat "(set app.count (+ app.count " step "))")',
      },
      {
        key: "app.modalContent", celType: "FormulaCel",
        metadata: { key: "app.modalContent", segment: "user", parser: "f", schema: "s", inputMap: { open: "app.modal.open", tmpl: "app.modal.template" } },
        f: '(if open tmpl "")',
      },
      {
        key: "app.view", celType: "FormulaCel",
        metadata: {
          key: "app.view", segment: "user", parser: "html-template-ref",
          schema: "render-spec", memo: { maxEntries: 64 },
          inputMap: {
            template: "app.template", mount: "app.mount", name: "user.name",
            uppercased: "app.uppercased", count: "app.count", doubled: "app.doubled",
            step: "app.incrementStep", theme: "app.theme.color", concat: "concat",
            incrementBinding: "app.incrementBinding", modalContent: "app.modalContent",
          },
        },
        f: "app.template",
      },
    ],
  }], [schemasManifest, userManifest]);
  await precomputeOptional(state);
  return state;
};

test("worked example renders the expected render-spec", async () => {
  const state = await bootWorkedExample();
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  const spec = state.cels.get("app.view").v;

  assert.equal(spec.mount, "#root", "mount comes from the reserved input");
  assert.deepEqual(spec.listeners, [], "no global listeners declared");

  const section = spec.vnode;
  assert.equal(section.tag, "section");
  assert.equal(section.attrs.style, "color: #0066cc", "attribute interpolation");

  assert.equal(textOf(childByTag(section, "h1")), "Hello, WORLD!", "text interpolation + toUpper");
  assert.equal(textOf(childByTag(section, "p")), "Count: 0 (doubled: 0)");

  const button = childByTag(section, "button");
  assert.equal(textOf(button), "+1");
  assert.deepEqual(button.events.click, { f: "(set app.count (+ app.count 1))" },
    "bare-symbol event slot wraps the binding-string into { f }");

  const input = childByTag(section, "input");
  assert.equal(input.attrs.value, "World");
  assert.deepEqual(input.events.input, { f: '(bindValue "user.name")' },
    "inline S-expression event slot captures source verbatim");

  assert.equal(childByTag(section, "div"), undefined, "modal absent while closed");
});

test("conditional sub-template inlines when its string turns non-empty", async () => {
  const state = await bootWorkedExample();
  const runCycle = resolveFn(state, "runCycle");
  const set = resolveFn(state, "set");
  await runCycle(state);

  await set(state, "app.modal.open", true);
  const modal = childByTag(state.cels.get("app.view").v.vnode, "div");
  assert.ok(modal, "modal div inlined once modalContent returns markup");
  assert.equal(modal.attrs.class, "modal");
  assert.equal(modal.attrs.role, "dialog");
  assert.deepEqual(childByTag(modal, "button").events.click, { f: "(set app.modal.open false)" });
});

// ── 3. L1 cache eligibility + hit on input-stable re-fire ───────────────────

test("worked-example view cel is L1-cache-eligible and hits on stable re-fire", async () => {
  const state = await bootWorkedExample();
  // No MemoEligibilityError should have been recorded for app.view.
  const errs = state.cels.get("errors")?.v ?? [];
  const eligErr = errs.find((e) => e?.trap === "MemoEligibilityError" && (e.at ?? []).includes("app.view"));
  assert.equal(eligErr, undefined, "all view inputs are memoSafe → eligibility passes");
  assert.ok(state.cels.get("app.view")._memoCache, "L1 cache allocated for the view cel");

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  const v1 = state.cels.get("app.view").v;
  await runCycle(state);
  const v2 = state.cels.get("app.view").v;
  assert.strictEqual(v1, v2, "input-stable re-fire returns the cached render-spec by reference");
});

// ── 4. list rendering → keyed children ready for keyed reconciliation ───────

test("a string of keyed elements inlines into keyed child vnodes", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [schemasSeg, {
    name: "user",
    cels: [
      {
        key: "rowsHtml", celType: "ValueCel",
        metadata: { key: "rowsHtml", segment: "user", schema: "s" },
        v: '<li key="a">A</li><li key="b">B</li>',
      },
      {
        key: "list", celType: "FormulaCel",
        metadata: { key: "list", segment: "user", parser: "html-template", schema: "render-spec", inputMap: { rows: "rowsHtml" } },
        f: "<ul>{{rows}}</ul>",
      },
    ],
  }], [schemasManifest, userManifest]);
  await precomputeOptional(state);

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  const ul = state.cels.get("list").v.vnode;
  assert.equal(ul.tag, "ul");
  assert.equal(ul.children.length, 2);
  assert.equal(ul.children[0].type, "el");
  assert.equal(ul.children[0].key, "a");
  assert.equal(ul.children[1].key, "b");
  assert.equal(textOf(ul.children[0]), "A");
});

// ── 5. vnode-embed: a value that IS a VNode (or VNode[]) embeds directly ────

test("a hole returning a VNode embeds it as a child (no stringify, no reparse)", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  // A registered fn whose value is a VNode. The template's text-slot hole
  // sees a vnode object and inserts it as a child.
  await register(state, {
    key: "badge",
    fn: () => ({ type: "el", tag: "span", attrs: { class: "badge" }, children: [{ type: "text", text: "v1" }] }),
    kind: "custom",
  });
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [schemasSeg, {
    name: "user",
    cels: [{
      key: "v", celType: "FormulaCel",
      metadata: { key: "v", segment: "user", parser: "html-template", inputMap: {} },
      f: "<div>before {{(badge)}} after</div>",
    }],
  }], [schemasManifest, userManifest]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);

  const vnode = state.cels.get("v").v.vnode;
  assert.equal(vnode.tag, "div");
  // children: ["before ", <span.badge>v1</span>, " after"]
  const span = vnode.children.find((c) => c.type === "el" && c.tag === "span");
  assert.ok(span, "VNode value embedded as a child element");
  assert.equal(span.attrs.class, "badge");
  assert.equal(textOf(span), "v1");
});

test("a hole returning a VNode[] embeds all of them", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "items",
    fn: () => [
      { type: "el", tag: "li", attrs: { key: "a" }, key: "a", children: [{ type: "text", text: "alpha" }] },
      { type: "el", tag: "li", attrs: { key: "b" }, key: "b", children: [{ type: "text", text: "beta" }] },
    ],
    kind: "custom",
  });
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [schemasSeg, {
    name: "user",
    cels: [{
      key: "v", celType: "FormulaCel",
      metadata: { key: "v", segment: "user", parser: "html-template", inputMap: {} },
      f: "<ul>{{(items)}}</ul>",
    }],
  }], [schemasManifest, userManifest]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);

  const ul = state.cels.get("v").v.vnode;
  assert.equal(ul.tag, "ul");
  assert.equal(ul.children.length, 2);
  assert.equal(ul.children[0].key, "a");
  assert.equal(ul.children[1].key, "b");
  assert.equal(textOf(ul.children[0]), "alpha");
});
