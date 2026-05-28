import type { CompiledEnvelope, CompiledLambda, Fn, Key, ResolvedInputs } from "../../types/index.js";
import { cellKey, expandRange, parseRef } from "./address.js";

// ============================================================================
// Infix formula parser — Excel-style `=A1*2` compiled into the FormulaCel
// CompiledEnvelope the kernel expects (fn + buildEvaluate), with extractDeps
// resolving A1-style references to sibling cell keys (A1 → sheet.A1) so
// hydrate auto-wires them into inputMap.
//
// A source without a leading `=` is a literal constant (number if numeric,
// else string) — though literal cells are normally ValueCels, a FormulaCel
// carrying a bare literal compiles to that constant for robustness.
//
// Supported: + - * / (arithmetic), & (string concat), = <> < > <= >=
// (comparison), unary -, parentheses, cell refs (A1), ranges (A1:B2, in
// function args), numbers, "strings", and the functions SUM / MIN / MAX /
// AVG / IF. Functions are evaluated inline (not cel calls), so the only
// dependencies are cell references.
// ============================================================================

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; ref: string }
  | { t: "range"; range: string }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "un"; op: string; e: Node }
  | { t: "call"; name: string; args: Node[] };

// ── tokenizer ────────────────────────────────────────────────────────────────

type Tok = { k: string; v: string };

const OPS2 = new Set(["<>", "<=", ">="]);

const tokenize = (src: string): Tok[] => {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      toks.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/&=<>(),:".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i;
      while (j < n && ((src[j]! >= "0" && src[j]! <= "9") || src[j] === ".")) j++;
      toks.push({ k: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      let j = i;
      while (j < n && /[A-Za-z0-9]/.test(src[j]!)) j++;
      toks.push({ k: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`infix: unexpected character "${c}" in "${src}"`);
  }
  return toks;
};

// ── recursive-descent parser ──────────────────────────────────────────────────
//
// Precedence low→high: comparison < concat(&) < additive < multiplicative
// < unary < primary.

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private eat(v: string): void {
    const t = this.next();
    if (!t || t.v !== v) throw new Error(`infix: expected "${v}"`);
  }

  parse(): Node {
    const node = this.comparison();
    if (this.pos < this.toks.length) throw new Error("infix: trailing tokens");
    return node;
  }

  private comparison(): Node {
    let l = this.concat();
    for (;;) {
      const t = this.peek();
      if (t?.k === "op" && (t.v === "=" || t.v === "<>" || t.v === "<" || t.v === ">" || t.v === "<=" || t.v === ">=")) {
        this.next();
        l = { t: "bin", op: t.v, l, r: this.concat() };
      } else break;
    }
    return l;
  }
  private concat(): Node {
    let l = this.additive();
    while (this.peek()?.v === "&") { this.next(); l = { t: "bin", op: "&", l, r: this.additive() }; }
    return l;
  }
  private additive(): Node {
    let l = this.multiplicative();
    for (;;) {
      const v = this.peek()?.v;
      if (v === "+" || v === "-") { this.next(); l = { t: "bin", op: v, l, r: this.multiplicative() }; }
      else break;
    }
    return l;
  }
  private multiplicative(): Node {
    let l = this.unary();
    for (;;) {
      const v = this.peek()?.v;
      if (v === "*" || v === "/") { this.next(); l = { t: "bin", op: v, l, r: this.unary() }; }
      else break;
    }
    return l;
  }
  private unary(): Node {
    const v = this.peek()?.v;
    if (v === "-" || v === "+") { this.next(); return { t: "un", op: v!, e: this.unary() }; }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new Error("infix: unexpected end");
    if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.v === "(") { const e = this.comparison(); this.eat(")"); return e; }
    if (t.k === "name") {
      // Function call?
      if (this.peek()?.v === "(") {
        this.next(); // (
        const args: Node[] = [];
        if (this.peek()?.v !== ")") {
          args.push(this.argument());
          while (this.peek()?.v === ",") { this.next(); args.push(this.argument()); }
        }
        this.eat(")");
        return { t: "call", name: t.v.toUpperCase(), args };
      }
      const upper = t.v.toUpperCase();
      if (upper === "TRUE") return { t: "bool", v: true };
      if (upper === "FALSE") return { t: "bool", v: false };
      if (parseRef(t.v)) return { t: "ref", ref: t.v.toUpperCase() };
      throw new Error(`infix: unknown name "${t.v}"`);
    }
    throw new Error(`infix: unexpected token "${t.v}"`);
  }
  // An argument may be a range (A1:B2) or an ordinary expression.
  private argument(): Node {
    const t = this.peek();
    if (t?.k === "name" && parseRef(t.v) && this.toks[this.pos + 1]?.v === ":") {
      const from = this.next()!.v;
      this.eat(":");
      const to = this.next();
      if (!to || !parseRef(to.v)) throw new Error("infix: bad range");
      return { t: "range", range: `${from.toUpperCase()}:${to.v.toUpperCase()}` };
    }
    return this.comparison();
  }
}

// ── evaluation ────────────────────────────────────────────────────────────────

type Lookup = (key: Key) => unknown;

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

const rangeValues = (range: string, lookup: Lookup): unknown[] =>
  expandRange(range).map((addr) => lookup(cellKey(addr)));

const evalNode = (node: Node, lookup: Lookup): unknown => {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "ref": return lookup(cellKey(node.ref));
    case "range": return rangeValues(node.range, lookup); // only meaningful in a call
    case "un": return node.op === "-" ? -num(evalNode(node.e, lookup)) : num(evalNode(node.e, lookup));
    case "bin": {
      const op = node.op;
      if (op === "&") return String(scalar(evalNode(node.l, lookup))) + String(scalar(evalNode(node.r, lookup)));
      const l = evalNode(node.l, lookup);
      const r = evalNode(node.r, lookup);
      switch (op) {
        case "+": return num(l) + num(r);
        case "-": return num(l) - num(r);
        case "*": return num(l) * num(r);
        case "/": return num(l) / num(r);
        case "=": return scalar(l) === scalar(r);
        case "<>": return scalar(l) !== scalar(r);
        case "<": return num(l) < num(r);
        case ">": return num(l) > num(r);
        case "<=": return num(l) <= num(r);
        case ">=": return num(l) >= num(r);
      }
      return null;
    }
    case "call": return evalCall(node, lookup);
  }
};

const scalar = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

const flatNums = (args: Node[], lookup: Lookup): number[] => {
  const out: number[] = [];
  for (const a of args) {
    if (a.t === "range") for (const v of rangeValues(a.range, lookup)) out.push(num(v));
    else out.push(num(evalNode(a, lookup)));
  }
  return out;
};

const evalCall = (node: { name: string; args: Node[] }, lookup: Lookup): unknown => {
  switch (node.name) {
    case "SUM": return flatNums(node.args, lookup).reduce((a, b) => a + b, 0);
    case "MIN": { const xs = flatNums(node.args, lookup); return xs.length ? Math.min(...xs) : 0; }
    case "MAX": { const xs = flatNums(node.args, lookup); return xs.length ? Math.max(...xs) : 0; }
    case "AVG": case "AVERAGE": { const xs = flatNums(node.args, lookup); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
    case "IF": {
      const cond = evalNode(node.args[0]!, lookup);
      return cond ? evalNode(node.args[1]!, lookup) : (node.args[2] ? evalNode(node.args[2], lookup) : false);
    }
    default: throw new Error(`infix: unknown function "${node.name}"`);
  }
};

// ── public surface ────────────────────────────────────────────────────────────

const isFormula = (src: string): boolean => src.trimStart().startsWith("=");

const parseSource = (src: string): Node => {
  const body = src.trimStart().slice(1); // drop the leading "="
  return new Parser(tokenize(body)).parse();
};

const literalNode = (src: string): Node => {
  const t = src.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return { t: "num", v: Number(t) };
  return { t: "str", v: src };
};

const collectDeps = (node: Node, acc: Set<Key>): void => {
  switch (node.t) {
    case "ref": acc.add(cellKey(node.ref)); break;
    case "range": for (const addr of expandRange(node.range)) acc.add(cellKey(addr)); break;
    case "un": collectDeps(node.e, acc); break;
    case "bin": collectDeps(node.l, acc); collectDeps(node.r, acc); break;
    case "call": for (const a of node.args) collectDeps(a, acc); break;
    default: break;
  }
};

const lookupFromInputs = (inputs: ResolvedInputs): Lookup => (key) => {
  const c = inputs[key];
  if (c === undefined || Array.isArray(c)) return undefined;
  return c.v;
};

/** The infix compiler — a FormulaCel parser. */
export const compileInfix = (source: string): CompiledLambda => {
  const ast = isFormula(source) ? parseSource(source) : literalNode(source);
  const envelope: CompiledEnvelope = {
    fn: ((record: Record<string, unknown>) => evalNode(ast, (k) => record[k])) as Fn,
    buildEvaluate: (inputs: ResolvedInputs) => {
      const lookup = lookupFromInputs(inputs);
      return (): unknown => evalNode(ast, lookup);
    },
  };
  return envelope;
};

compileInfix.extractDeps = (source: string): Key[] => {
  if (!isFormula(source)) return [];
  const acc = new Set<Key>();
  collectDeps(parseSource(source), acc);
  return [...acc];
};
