import type { Fn, Key } from "../../../plastron/src/types/index.js";

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
//   factor → number | ref | "-" factor | "(" expr ")"
//
// `ref` is a cell address like `A1`, `B12`, `AB7`. `number` is a JS
// float. A leading "=" is stripped before parsing so users can store
// either `=A1+1` or `A1+1` as cel.f.
// ========================================================================

type Ast =
  | { kind: "num"; v: number }
  | { kind: "ref"; key: Key }
  | { kind: "neg"; arg: Ast }
  | { kind: "op"; op: "+" | "-" | "*" | "/"; l: Ast; r: Ast };

const tokenize = (src: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if ("+-*/()".includes(c)) { out.push(c); i++; continue; }
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
    if (/^[A-Z]+[0-9]+$/.test(t))         { pos++; return { kind: "ref", key: t }; }
    throw new Error(`Unexpected token "${t}" in formula "${src}"`);
  };

  const ast = expr();
  if (pos < tokens.length) throw new Error(`Trailing input in formula "${src}"`);
  return ast;
};

const evaluate = (ast: Ast, inputs: Record<string, unknown>): number => {
  switch (ast.kind) {
    case "num": return ast.v;
    case "ref": {
      const v = inputs[ast.key];
      if (v === null || v === undefined || v === "") return 0;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case "neg": return -evaluate(ast.arg, inputs);
    case "op": {
      const l = evaluate(ast.l, inputs);
      const r = evaluate(ast.r, inputs);
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
    case "num": return;
    case "ref": into.add(ast.key); return;
    case "neg": collectRefs(ast.arg, into); return;
    case "op": collectRefs(ast.l, into); collectRefs(ast.r, into); return;
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
