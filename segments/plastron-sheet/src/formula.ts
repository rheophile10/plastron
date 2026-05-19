import type { Fn, Key } from "../../../plastron/src/types/index.js";
import { addressOf, parseAddress } from "./domain/address.js";

// ========================================================================
// Excel-style infix formula compiler.
//
// Replaces the kernel's default S-expression compiler at fns key "f"
// — that slot is intentionally unlocked so a host can swap formula
// languages. We register `infixFormula` from main.ts via the fns map
// passed to hydrate; the kernel auto-wires `cel._fn = infixFormula(src)`
// for every cel that has a `f:` field.
//
// Grammar (recursive descent):
//   expr   → term ((+|-) term)*
//   term   → factor ((*|/) factor)*
//   factor → number
//          | ref      (A1, B12, AB7)
//          | range    (A1:B10 — expands at evaluate time to a JS array)
//          | call     (SUM(args), with args being expr-shaped, including
//                      ranges and nested calls)
//          | "-" factor
//          | "(" expr ")"
//
// `ref` is a cell address like `A1`, `B12`, `AB7`. `number` is a JS
// float. A leading "=" is stripped before parsing so users can store
// either `=A1+1` or `A1+1` as cel.f.
//
// Function-call resolution: a bare identifier followed by `(...)` is
// compiled as a reference to the cel keyed `fn:<NAME>`. Function-library
// segments (`sheet:fn:math`, `sheet:fn:text`, …) hydrate native-fn cels
// at those keys whose `v` is the JS implementation. extractDeps emits
// the `fn:<NAME>` keys alongside cell refs so hydrate's auto-wire
// builds the right inputMap automatically.
// ========================================================================

type Ast =
  | { kind: "num"; v: number }
  | { kind: "ref"; key: Key }
  | { kind: "range"; cells: Key[] }
  | { kind: "call"; fnKey: Key; args: Ast[] }
  | { kind: "neg"; arg: Ast }
  | { kind: "op"; op: "+" | "-" | "*" | "/"; l: Ast; r: Ast };

const enumerateRange = (from: string, to: string): Key[] => {
  const a = parseAddress(from);
  const b = parseAddress(to);
  if (!a || !b) return [from, to];
  const c0 = Math.min(a.col, b.col); const c1 = Math.max(a.col, b.col);
  const r0 = Math.min(a.row, b.row); const r1 = Math.max(a.row, b.row);
  const out: Key[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(addressOf(c, r));
  }
  return out;
};

const tokenize = (src: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if ("+-*/(),:".includes(c)) { out.push(c); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      out.push(src.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${c}" in formula "${src}"`);
  }
  return out;
};

const parse = (src: string): Ast => {
  const stripped = src.startsWith("=") ? src.slice(1) : src;
  const tokens = tokenize(stripped);
  if (tokens.length === 0) throw new Error(`Empty formula "${src}"`);
  let pos = 0;

  const expr = (): Ast => {
    let left = term();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++] as "+" | "-";
      left = { kind: "op", op, l: left, r: term() };
    }
    return left;
  };

  const term = (): Ast => {
    let left = factor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++] as "*" | "/";
      left = { kind: "op", op, l: left, r: factor() };
    }
    return left;
  };

  const parseArgs = (): Ast[] => {
    const args: Ast[] = [];
    if (tokens[pos] === ")") return args;
    args.push(expr());
    while (tokens[pos] === ",") { pos++; args.push(expr()); }
    return args;
  };

  const factor = (): Ast => {
    const t = tokens[pos];
    if (t === undefined) throw new Error(`Unexpected end of formula "${src}"`);
    if (t === "-") { pos++; return { kind: "neg", arg: factor() }; }
    if (t === "(") {
      pos++;
      const e = expr();
      if (tokens[pos] !== ")") throw new Error(`Missing ")" in formula "${src}"`);
      pos++;
      return e;
    }
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(t)) { pos++; return { kind: "num", v: Number(t) }; }

    // Cell ref or range or call (cell-ref-shaped identifier followed
    // by `(`). Excel allows `MAX1` as both a cell ref AND a function
    // name depending on context — the `(` lookahead disambiguates.
    if (/^[A-Z]+[0-9]+$/.test(t)) {
      pos++;
      if (tokens[pos] === "(") {
        pos++;
        const args = parseArgs();
        if (tokens[pos] !== ")") throw new Error(`Missing ")" after function arguments in formula "${src}"`);
        pos++;
        return { kind: "call", fnKey: `fn:${t}`, args };
      }
      if (tokens[pos] === ":") {
        pos++;
        const to = tokens[pos];
        if (!to || !/^[A-Z]+[0-9]+$/.test(to)) throw new Error(`Expected cell address after ":" in formula "${src}"`);
        pos++;
        return { kind: "range", cells: enumerateRange(t, to) };
      }
      return { kind: "ref", key: t };
    }

    // Plain identifier (no trailing digits) — must be a function call.
    if (/^[A-Z]+$/.test(t)) {
      pos++;
      if (tokens[pos] !== "(") {
        throw new Error(`Unknown identifier "${t}" in formula "${src}" — did you mean "${t}(...)"?`);
      }
      pos++;
      const args = parseArgs();
      if (tokens[pos] !== ")") throw new Error(`Missing ")" after function arguments in formula "${src}"`);
      pos++;
      return { kind: "call", fnKey: `fn:${t}`, args };
    }

    throw new Error(`Unexpected token "${t}" in formula "${src}"`);
  };

  const ast = expr();
  if (pos < tokens.length) throw new Error(`Trailing input in formula "${src}"`);
  return ast;
};

/** Coerce an arbitrary cel value to a JS number for arithmetic. Empty
 *  / null / undefined / non-numeric strings all collapse to 0 —
 *  matches Excel's "blank cell in an arithmetic expression = 0". */
const toNumber = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const evaluate = (ast: Ast, inputs: Record<string, unknown>): unknown => {
  switch (ast.kind) {
    case "num": return ast.v;
    case "ref": return inputs[ast.key];
    case "range": {
      // Materialize the range into a JS array of cel values. Function
      // implementations (SUM, AVG, …) accept arrays as args and walk
      // them themselves; arithmetic ops force-coerce to a number,
      // which on an array gives NaN → toNumber → 0 (Excel parity:
      // `=A1:A3+1` is meaningless and yields a useless value).
      return ast.cells.map((c) => inputs[c]);
    }
    case "call": {
      const fn = inputs[ast.fnKey];
      if (typeof fn !== "function") {
        throw new Error(`Function "${ast.fnKey}" is not registered (looked up in inputs).`);
      }
      const args = ast.args.map((a) => evaluate(a, inputs));
      return (fn as (...a: unknown[]) => unknown)(...args);
    }
    case "neg": return -toNumber(evaluate(ast.arg, inputs));
    case "op": {
      const l = toNumber(evaluate(ast.l, inputs));
      const r = toNumber(evaluate(ast.r, inputs));
      switch (ast.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
      }
    }
  }
};

const collectRefs = (ast: Ast, into: Set<Key>): void => {
  switch (ast.kind) {
    case "num":   return;
    case "ref":   into.add(ast.key); return;
    case "range": for (const c of ast.cells) into.add(c); return;
    case "call":  into.add(ast.fnKey); for (const a of ast.args) collectRefs(a, into); return;
    case "neg":   collectRefs(ast.arg, into); return;
    case "op":    collectRefs(ast.l, into); collectRefs(ast.r, into); return;
  }
};

/** Compile a formula source string to a runtime Fn. The Fn takes the
 *  inputs record (cel-key → cel.v) and returns the evaluated number. */
const compile = (src: string): Fn => {
  const ast = parse(src);
  return (inputs: Record<string, unknown>) => evaluate(ast, inputs);
};

/** Cel keys referenced by the formula, in first-seen order. Hydrate
 *  uses this to auto-wire cel.inputMap. */
const extractDeps = (src: string): Key[] => {
  const ast = parse(src);
  const refs = new Set<Key>();
  collectRefs(ast, refs);
  return [...refs];
};

/** The Fn the host registers at fns key "f". When called with a source
 *  string, returns the compiled runtime fn. The `extractDeps` property
 *  is consulted by hydrate to drive auto-wiring. */
export const infixFormula: Fn = (src: string) => compile(src);
infixFormula.extractDeps = extractDeps;
