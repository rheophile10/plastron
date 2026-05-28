import type {
  CompiledEnvelope, CompiledLambda, Fn, Key, ResolvedInputs,
} from "../../types/index.js";
import { compileFormula, extractDeps } from "../../kernel/formula.js";
import type {
  AttrValue, EventBinding, RenderSpec, VElement, VNode,
} from "./vnode.js";

// ============================================================================
// html-template parser — HTML-shaped templates with `{{…}}` interpolation
// compiled into a render-spec ({ vnode, mount, listeners }) producer.
//
// Two parser variants share this module (see htm-view-layers.md):
//   • html-template      — the FormulaCel's `f` IS the template source.
//                          Parsed once at compile; interpolation deps are
//                          auto-wired into inputMap via extractDeps.
//   • html-template-ref  — the FormulaCel's `f` is a cel KEY; the template
//                          lives in a ValueCel reached through the reserved
//                          input name "template" and is (re)parsed at render
//                          time, so live-editable templates work. Deps are
//                          author-declared (extractDeps returns nothing).
//
// Interpolation bodies are formula syntax (the kernel's S-expression `f`
// language). The slot the interpolation sits in decides how its value is
// used — see the table in htm-view-layers.md. Reserved input names read at
// render time: `mount` (string | null), `listeners` (string[]), and, for
// the ref variant, `template` (the template source string).
// ============================================================================

// ── template AST ────────────────────────────────────────────────────────────

interface Hole {
  source: string;
  fn: Fn;            // compiled formula entry: (record) => value
}

type TextPart = { lit: string } | { hole: Hole };

interface TplText {
  kind: "text";
  parts: TextPart[];
}

type EventTmpl =
  | { kind: "verbatim"; source: string }   // inline S-expr → { f: source }
  | { kind: "value"; hole: Hole };         // bare symbol → wrap its value

interface TplEl {
  kind: "el";
  tag: string;
  staticAttrs: Record<string, AttrValue>;
  dynAttrs: Array<{ name: string; hole: Hole }>;
  events: Array<{ type: string; binding: EventTmpl }>;
  staticKey?: string;
  keyHole?: Hole;
  children: TemplateNode[];
}

type TemplateNode = TplText | TplEl;

// ── parser ──────────────────────────────────────────────────────────────────

const isNameChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") || c === "-" || c === "_" || c === ":" || c === ".";

const isWs = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r";

// Void elements never have children / a close tag.
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const mkHole = (source: string): Hole => ({
  source,
  fn: (compileFormula(source) as CompiledEnvelope).fn,
});

// Split a raw text run into literal + hole parts. A literal part that is
// pure whitespace AND contains a newline is dropped (template indentation);
// inline single spaces between holes survive.
const splitText = (raw: string): TextPart[] => {
  const parts: TextPart[] = [];
  let i = 0;
  const pushLit = (s: string): void => {
    if (s.length === 0) return;
    if (/^\s*$/.test(s) && s.includes("\n")) return;
    parts.push({ lit: s });
  };
  while (i < raw.length) {
    const open = raw.indexOf("{{", i);
    if (open === -1) { pushLit(raw.slice(i)); break; }
    pushLit(raw.slice(i, open));
    const close = raw.indexOf("}}", open + 2);
    if (close === -1) throw new Error(`Unterminated {{ in template text: ${raw.slice(open, open + 40)}`);
    parts.push({ hole: mkHole(raw.slice(open + 2, close).trim()) });
    i = close + 2;
  }
  return parts;
};

interface Cursor { src: string; pos: number; }

const parseNodes = (cur: Cursor, stopTag: string | null): TemplateNode[] => {
  const out: TemplateNode[] = [];
  while (cur.pos < cur.src.length) {
    if (cur.src.startsWith("</", cur.pos)) {
      if (stopTag === null) throw new Error(`Unexpected close tag at ${cur.pos}`);
      return out; // caller consumes the close tag
    }
    if (cur.src[cur.pos] === "<") {
      out.push(parseElement(cur));
      continue;
    }
    // Text run up to the next tag.
    const next = cur.src.indexOf("<", cur.pos);
    const end = next === -1 ? cur.src.length : next;
    const parts = splitText(cur.src.slice(cur.pos, end));
    if (parts.length > 0) out.push({ kind: "text", parts });
    cur.pos = end;
  }
  if (stopTag !== null) throw new Error(`Unclosed <${stopTag}>`);
  return out;
};

const readName = (cur: Cursor): string => {
  const start = cur.pos;
  while (cur.pos < cur.src.length && isNameChar(cur.src[cur.pos]!)) cur.pos++;
  return cur.src.slice(start, cur.pos);
};

const skipWs = (cur: Cursor): void => {
  while (cur.pos < cur.src.length && isWs(cur.src[cur.pos]!)) cur.pos++;
};

const isEventName = (name: string): boolean =>
  name.length > 2 && name.startsWith("on") && name[2] === name[2]!.toUpperCase();

// Read an attribute value: "quoted", {{interpolation}}, or bare token.
// Returns { lit } for static strings or { hole } for interpolations.
const readAttrValue = (cur: Cursor): { lit?: string; hole?: Hole } => {
  const c = cur.src[cur.pos];
  if (c === '"' || c === "'") {
    const q = c;
    cur.pos++;
    const start = cur.pos;
    while (cur.pos < cur.src.length && cur.src[cur.pos] !== q) cur.pos++;
    const lit = cur.src.slice(start, cur.pos);
    cur.pos++; // closing quote
    if (lit.startsWith("{{") && lit.endsWith("}}")) {
      return { hole: mkHole(lit.slice(2, -2).trim()) };
    }
    return { lit };
  }
  if (cur.src.startsWith("{{", cur.pos)) {
    const close = cur.src.indexOf("}}", cur.pos + 2);
    if (close === -1) throw new Error(`Unterminated {{ in attribute at ${cur.pos}`);
    const body = cur.src.slice(cur.pos + 2, close).trim();
    cur.pos = close + 2;
    return { hole: mkHole(body) };
  }
  // Bare token.
  const start = cur.pos;
  while (cur.pos < cur.src.length && !isWs(cur.src[cur.pos]!) &&
         cur.src[cur.pos] !== ">" && cur.src[cur.pos] !== "/") cur.pos++;
  return { lit: cur.src.slice(start, cur.pos) };
};

const eventBindingFromValue = (v: { lit?: string; hole?: Hole }): EventTmpl => {
  if (v.hole) {
    // An interpolation whose body is an S-expression is captured verbatim
    // (the painter compiles it lazily); a bare symbol is read as a value
    // at render time and wrapped.
    const body = v.hole.source;
    if (body.startsWith("(")) return { kind: "verbatim", source: body };
    return { kind: "value", hole: v.hole };
  }
  // Static string in an event slot → treat as a formula-source binding.
  return { kind: "verbatim", source: v.lit ?? "" };
};

const parseElement = (cur: Cursor): TplEl => {
  cur.pos++; // consume "<"
  const tag = readName(cur);
  if (tag.length === 0) throw new Error(`Empty tag name at ${cur.pos}`);
  const node: TplEl = {
    kind: "el", tag, staticAttrs: {}, dynAttrs: [], events: [], children: [],
  };

  // Attributes.
  for (;;) {
    skipWs(cur);
    const c = cur.src[cur.pos];
    if (c === undefined) throw new Error(`Unclosed tag <${tag}>`);
    if (c === ">" || c === "/") break;
    const name = readName(cur);
    if (name.length === 0) throw new Error(`Bad attribute in <${tag}> at ${cur.pos}`);
    skipWs(cur);
    let value: { lit?: string; hole?: Hole } = {};
    if (cur.src[cur.pos] === "=") {
      cur.pos++;
      skipWs(cur);
      value = readAttrValue(cur);
    } else {
      value = { lit: "" }; // boolean attribute
    }

    if (isEventName(name)) {
      node.events.push({ type: name.slice(2).toLowerCase(), binding: eventBindingFromValue(value) });
    } else if (name === "key") {
      if (value.hole) node.keyHole = value.hole;
      else node.staticKey = value.lit ?? "";
    } else if (value.hole) {
      node.dynAttrs.push({ name, hole: value.hole });
    } else {
      node.staticAttrs[name] = value.lit === "" ? true : (value.lit ?? "");
    }
  }

  // Close or children.
  if (cur.src[cur.pos] === "/") {
    cur.pos++; // "/"
    if (cur.src[cur.pos] !== ">") throw new Error(`Expected "/>" in <${tag}>`);
    cur.pos++; // ">"
    return node;
  }
  cur.pos++; // ">"
  if (VOID_TAGS.has(tag.toLowerCase())) return node;

  node.children = parseNodes(cur, tag);
  // Consume the matching close tag.
  if (!cur.src.startsWith("</", cur.pos)) throw new Error(`Expected </${tag}>`);
  cur.pos += 2;
  const closeTag = readName(cur);
  if (closeTag !== tag) throw new Error(`Mismatched close </${closeTag}> for <${tag}>`);
  skipWs(cur);
  if (cur.src[cur.pos] !== ">") throw new Error(`Expected ">" closing </${tag}>`);
  cur.pos++;
  return node;
};

const parseTemplate = (source: string): TemplateNode[] =>
  parseNodes({ src: source, pos: 0 }, null);

// Parse cache for the ref variant — templates re-render off a ValueCel, so
// reparse only when the string identity changes.
const parseCache = new Map<string, TemplateNode[]>();
const parseCached = (source: string): TemplateNode[] => {
  let ast = parseCache.get(source);
  if (!ast) { ast = parseTemplate(source); parseCache.set(source, ast); }
  return ast;
};

// ── dep extraction ──────────────────────────────────────────────────────────

const collectDeps = (nodes: TemplateNode[], acc: Set<Key>): void => {
  for (const n of nodes) {
    if (n.kind === "text") {
      for (const p of n.parts) if ("hole" in p) addDeps(p.hole, acc);
      continue;
    }
    for (const a of n.dynAttrs) addDeps(a.hole, acc);
    if (n.keyHole) addDeps(n.keyHole, acc);
    for (const e of n.events) {
      // Verbatim event sources are compiled lazily by the painter — they
      // contribute NO deps to the view cel (htm-view-layers event-slot rule).
      if (e.binding.kind === "value") addDeps(e.binding.hole, acc);
    }
    collectDeps(n.children, acc);
  }
};

const addDeps = (hole: Hole, acc: Set<Key>): void => {
  for (const d of extractDeps(hole.source)) acc.add(d);
};

// ── render ──────────────────────────────────────────────────────────────────

const coerceAttr = (v: unknown): AttrValue => {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v as AttrValue;
  return String(v);
};

/** A value qualifies for vnode-embed if it carries the VNode discriminator
 *  (a `type: "el" | "text"` field). Recognized in text-slot interpolations. */
const isVNodeValue = (v: unknown): boolean =>
  !!v && typeof v === "object" && "type" in (v as object) &&
  ((v as { type: unknown }).type === "el" || (v as { type: unknown }).type === "text");

const bindingFromValue = (v: unknown): EventBinding | null => {
  if (typeof v === "string") return { f: v };
  if (v && typeof v === "object") return v as EventBinding;
  return null;
};

const renderNodes = (
  nodes: TemplateNode[],
  record: Record<string, unknown>,
  out: VNode[],
): void => {
  for (const n of nodes) {
    if (n.kind === "text") {
      for (const p of n.parts) {
        if ("lit" in p) { out.push({ type: "text", text: p.lit }); continue; }
        const v = p.hole.fn(record);
        // VNode (or VNode[]) values embed directly as children — no
        // stringify, no fragment re-parse. The general-purpose primitive that
        // lets a registered fn or another cel's render-spec compose into a
        // template. See sheet-keyed-render for the headline consumer.
        if (isVNodeValue(v)) { out.push(v as VNode); continue; }
        if (Array.isArray(v) && v.length > 0 && v.every(isVNodeValue)) {
          for (const n of v) out.push(n as VNode);
          continue;
        }
        // A string carrying markup is reparsed as a template fragment and
        // inlined — the conditional-sub-template composition primitive.
        if (typeof v === "string" && v.includes("<")) {
          renderNodes(parseCached(v), record, out);
        } else if (v !== "" && v !== null && v !== undefined) {
          out.push({ type: "text", text: String(v) });
        }
      }
      continue;
    }
    out.push(renderElement(n, record));
  }
};

const renderElement = (n: TplEl, record: Record<string, unknown>): VElement => {
  const el: VElement = { type: "el", tag: n.tag };

  let attrs: Record<string, AttrValue> | undefined;
  for (const [k, val] of Object.entries(n.staticAttrs)) {
    (attrs ??= {})[k] = val;
  }
  for (const a of n.dynAttrs) {
    (attrs ??= {})[a.name] = coerceAttr(a.hole.fn(record));
  }
  if (attrs) el.attrs = attrs;

  if (n.events.length > 0) {
    const events: Record<string, EventBinding> = {};
    for (const e of n.events) {
      const b = e.binding.kind === "verbatim"
        ? { f: e.binding.source }
        : bindingFromValue(e.binding.hole.fn(record));
      if (b) events[e.type] = b;
    }
    if (Object.keys(events).length > 0) el.events = events;
  }

  if (n.staticKey !== undefined) el.key = n.staticKey;
  else if (n.keyHole) {
    const kv = n.keyHole.fn(record);
    if (kv !== null && kv !== undefined) el.key = String(kv);
  }

  if (n.children.length > 0) {
    const kids: VNode[] = [];
    renderNodes(n.children, record, kids);
    if (kids.length > 0) el.children = kids;
  }
  return el;
};

const renderRoot = (nodes: TemplateNode[], record: Record<string, unknown>): VNode => {
  const top: VNode[] = [];
  renderNodes(nodes, record, top);
  const elements = top.filter((v) => v.type === "el");
  if (elements.length === 1) return elements[0]!;
  // No single root element → wrap (keeps render-spec.vnode a single node).
  return { type: "el", tag: "div", children: top };
};

const renderSpecFrom = (vnode: VNode, record: Record<string, unknown>): RenderSpec => {
  const mount = record.mount;
  const listeners = record.listeners;
  return {
    vnode,
    mount: typeof mount === "string" ? mount : null,
    listeners: Array.isArray(listeners) ? (listeners as string[]) : [],
  };
};

// Build a value-or-callable record from resolved input cels. Mirrors the
// formula evaluator's head-vs-arg rule: a FormulaCel contributes its
// computed value; a Lambda / Compiler contributes its callable; everything
// else contributes its value.
const recordFromCels = (inputs: ResolvedInputs): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  for (const [name, cs] of Object.entries(inputs)) {
    if (cs === undefined) { record[name] = undefined; continue; }
    if (Array.isArray(cs)) { record[name] = cs.map((c) => c?.v); continue; }
    const anyCel = cs as { celType: string; v: unknown; _fn?: unknown };
    record[name] = anyCel.celType === "FormulaCel"
      ? anyCel.v
      : (anyCel._fn ?? anyCel.v);
  }
  return record;
};

// ── compilers ─────────────────────────────────────────────────────────────

/** Build the compiler for the inline `html-template` variant. */
export const compileHtmlTemplate = (source: string): CompiledLambda => {
  const ast = parseTemplate(source);
  const deps = new Set<Key>();
  collectDeps(ast, deps);

  const envelope: CompiledEnvelope = {
    fn: ((record: Record<string, unknown>) =>
      renderSpecFrom(renderRoot(ast, record), record)) as Fn,
    buildEvaluate: (inputs: ResolvedInputs) => {
      return (): RenderSpec => {
        const record = recordFromCels(inputs);
        return renderSpecFrom(renderRoot(ast, record), record);
      };
    },
  };
  return envelope;
};
compileHtmlTemplate.extractDeps = (source: string): Key[] => {
  const acc = new Set<Key>();
  collectDeps(parseTemplate(source), acc);
  return [...acc];
};

/** Build the compiler for the `html-template-ref` variant — the template
 *  source is read from the reserved input name "template" at render time
 *  and reparsed when its string identity changes. Deps are author-declared
 *  (extractDeps is intentionally empty). */
export const compileHtmlTemplateRef = (_source: string): CompiledLambda => {
  const renderFrom = (record: Record<string, unknown>): RenderSpec => {
    const raw = record.template;
    // A ValueCel may hold the template as string[] lines (the multiline
    // authoring affordance); join them the same way inflateCel joins a
    // fireable cel's `f`.
    const tmpl = Array.isArray(raw) ? raw.join("\n") : raw;
    if (typeof tmpl !== "string") {
      throw new Error(
        `html-template-ref: reserved input "template" must resolve to a ` +
        `string or string[] (got ${typeof raw}). Wire it via inputMap, e.g. ` +
        `{ "template": "<templateCelKey>" }.`,
      );
    }
    return renderSpecFrom(renderRoot(parseCached(tmpl), record), record);
  };
  const envelope: CompiledEnvelope = {
    fn: ((record: Record<string, unknown>) => renderFrom(record)) as Fn,
    buildEvaluate: (inputs: ResolvedInputs) =>
      (): RenderSpec => renderFrom(recordFromCels(inputs)),
  };
  return envelope;
};
compileHtmlTemplateRef.extractDeps = (_source: string): Key[] => [];

// Exposed for tests / tooling that want the parsed shape without a cel.
export { parseTemplate };
