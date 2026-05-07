import type { Fn, Key } from "../types/index.js";

// ============================================================================
// S-expression formula parser.
//
// Grammar (informally):
//   expr = NUMBER | SYMBOL | '(' expr* ')'
//
// A list `(head arg1 arg2 …)` is either a builtin operator call or a
// function call:
//   • If `head` matches a builtin (+ - * /), apply numerically.
//   • Otherwise look up `inputs[head]` — must be a function value.
//     Cels can hold function values, so to expose a function in formulas
//     just put it in a cel and reference its key.
//
// Symbols that aren't builtins are treated as cel references — both
// when they appear bare (`a`) and when they appear as the head of a
// list (`(myFn a b)`). Hydrate's auto-wire pulls every such symbol
// into inputMap.
//
// Numbers are JS floats. Non-numeric values flowing through arithmetic
// coerce via Number() and propagate NaN honestly.
// ============================================================================

type SExp = number | string | SExp[];

const BUILTINS: Record<string, (args: unknown[]) => number> = {
  "+": (args) => args.reduce<number>((a, b) => a + Number(b), 0),
  "*": (args) => args.reduce<number>((a, b) => a * Number(b), 1),
  "-": (args) => {
    if (args.length === 0) return 0;
    if (args.length === 1) return -Number(args[0]);
    return args.slice(1).reduce<number>((a, b) => a - Number(b), Number(args[0]));
  },
  "/": (args) => {
    if (args.length === 0) return NaN;
    if (args.length === 1) return 1 / Number(args[0]);
    return args.slice(1).reduce<number>((a, b) => a / Number(b), Number(args[0]));
  },
};

const tokenize = (src: string): string[] =>
  src.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);

const parse = (src: string): SExp => {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error(`Empty formula "${src}"`);
  let pos = 0;

  const read = (): SExp => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`Unexpected end of formula "${src}"`);
    if (t === ")")        throw new Error(`Unexpected ')' in formula "${src}"`);
    if (t === "(") {
      const list: SExp[] = [];
      while (tokens[pos] !== ")") {
        if (pos >= tokens.length) throw new Error(`Unterminated list in formula "${src}"`);
        list.push(read());
      }
      pos++; // consume ')'
      return list;
    }
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
    return t; // symbol
  };

  const result = read();
  if (pos < tokens.length) throw new Error(`Trailing tokens in formula "${src}"`);
  return result;
};

const evaluate = (exp: SExp, inputs: Record<string, unknown>): unknown => {
  if (typeof exp === "number") return exp;
  if (typeof exp === "string") return inputs[exp];
  if (exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluate(a, inputs));

  if (head in BUILTINS) return BUILTINS[head](args);

  const fn = inputs[head];
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function or builtin.`);
  }
  return fn(...args);
};

/** Symbols referenced by the formula, in first-seen order. Builtins
 *  (+ - * /) are excluded; everything else (data refs and function
 *  refs alike) is returned for hydrate to auto-wire into inputMap. */
export const extractDeps = (src: string): Key[] => {
  const ast = parse(src);
  const seen = new Set<string>();
  const out: Key[] = [];
  const visit = (e: SExp): void => {
    if (typeof e === "string") {
      if (e in BUILTINS || seen.has(e)) return;
      seen.add(e);
      out.push(e);
    } else if (Array.isArray(e)) {
      for (const c of e) visit(c);
    }
  };
  visit(ast);
  return out;
};

/** Parse a formula once and return a Fn that evaluates it against an
 *  inputs record. Throws on parse errors. */
export const compileFormula = (src: string): Fn => {
  const ast = parse(src);
  return (inputs: Record<string, unknown>) => evaluate(ast, inputs);
};
