import type { CompiledLambda, Fn, Key, ResolvedInputs } from "../types/index.js";

// ============================================================================
// S-expression formula parser + compiler.
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
//
// compileFormula returns a CompiledEnvelope:
//   • fn            — generic Fn(inputs) entry point used by callers
//                     that pass a freshly-built inputs object
//                     (registerLambda fast path, ad-hoc invocation)
//   • buildEvaluate — closure builder consumed by precompute. Captures
//                     resolved cel refs directly and skips inputs-
//                     object construction at fire time. Two
//                     implementations chosen at module load:
//                       • new-Function codegen for max V8 inlining
//                       • AST-walk against resolved cels when CSP
//                         blocks new Function or the formula uses
//                         array-typed inputs (which the codegen path
//                         doesn't emit for)
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

// ── buildEvaluate plumbing ──────────────────────────────────────────────────

// Detect whether `new Function` works in this environment. Strict CSP
// (script-src 'self' without 'unsafe-eval') blocks it. Detected once
// at module load; result is stable for the process lifetime.
const CODEGEN_AVAILABLE: boolean = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function("return 1")();
    return true;
  } catch {
    return false;
  }
})();

// Walk the AST against resolved cels — same shape as `evaluate` but
// reads cel.v inline rather than from a pre-built inputs record.
// Used by buildEvaluate when codegen isn't available or the formula
// uses array-typed inputs (which the codegen path doesn't emit for).
const evaluateAgainstCels = (
  exp: SExp,
  cels: ResolvedInputs,
): unknown => {
  if (typeof exp === "number") return exp;
  if (typeof exp === "string") {
    const c = cels[exp];
    if (c === undefined) return undefined;
    if (Array.isArray(c)) return c.map((x) => x?.v);
    return c.v;
  }
  if (!Array.isArray(exp) || exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluateAgainstCels(a, cels));

  if (head in BUILTINS) return BUILTINS[head](args);

  const c = cels[head];
  const fn = (c !== undefined && !Array.isArray(c)) ? c.v : undefined;
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function or builtin.`);
  }
  return (fn as (...a: unknown[]) => unknown)(...args);
};

// Generate a JS expression body for the AST. Each unique symbol becomes
// a closure parameter `c0`, `c1`, …; references in the expression read
// `cN.v`. Function calls compile to `cN.v(arg, …)`. Builtins emit raw
// arithmetic with Number() coercion to preserve the interpreter's
// behavior on string inputs.
const generateBody = (
  ast: SExp,
): { body: string; symbols: string[] } => {
  const symbols: string[] = [];
  const symbolIndex = new Map<string, number>();
  const indexFor = (name: string): number => {
    let i = symbolIndex.get(name);
    if (i === undefined) {
      i = symbols.length;
      symbolIndex.set(name, i);
      symbols.push(name);
    }
    return i;
  };

  const gen = (exp: SExp): string => {
    if (typeof exp === "number") return JSON.stringify(exp);
    if (typeof exp === "string") {
      if (exp in BUILTINS) {
        // Builtin appearing bare (not as list head) is degenerate.
        // Fall back to AST walk for this formula by signalling.
        throw new Error(`Builtin "${exp}" used as a value`);
      }
      return `c${indexFor(exp)}.v`;
    }
    if (!Array.isArray(exp) || exp.length === 0) return "null";

    const head = exp[0];
    if (typeof head !== "string") {
      throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
    }
    const args = exp.slice(1).map(gen);

    if (head === "+") {
      if (args.length === 0) return "0";
      return `(${args.map((a) => `Number(${a})`).join("+")})`;
    }
    if (head === "*") {
      if (args.length === 0) return "1";
      return `(${args.map((a) => `Number(${a})`).join("*")})`;
    }
    if (head === "-") {
      if (args.length === 0) return "0";
      if (args.length === 1) return `(-Number(${args[0]}))`;
      return `(${args.map((a) => `Number(${a})`).join("-")})`;
    }
    if (head === "/") {
      if (args.length === 0) return "NaN";
      if (args.length === 1) return `(1/Number(${args[0]}))`;
      return `(${args.map((a) => `Number(${a})`).join("/")})`;
    }
    return `c${indexFor(head)}.v(${args.join(",")})`;
  };

  return { body: gen(ast), symbols };
};

const hasArrayInput = (cels: ResolvedInputs, symbols: string[]): boolean => {
  for (const name of symbols) {
    if (Array.isArray(cels[name])) return true;
  }
  return false;
};

const buildEvaluateFor = (ast: SExp, cels: ResolvedInputs): (() => unknown) => {
  if (CODEGEN_AVAILABLE) {
    let body: string;
    let symbols: string[];
    try {
      ({ body, symbols } = generateBody(ast));
    } catch {
      // Codegen-side limitation (e.g. bare builtin) — fall through to
      // AST walk, which handles the same edge cases consistently.
      return () => evaluateAgainstCels(ast, cels);
    }
    // Codegen output assumes scalar refs. If any input resolved to an
    // array, fall back to the AST walk which handles arrays correctly.
    if (hasArrayInput(cels, symbols)) {
      return () => evaluateAgainstCels(ast, cels);
    }
    const params = symbols.map((_, i) => `c${i}`);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      ...params,
      `"use strict"; return function evaluate() { return ${body}; };`,
    );
    const args = symbols.map((name) => cels[name]);
    return factory(...args) as () => unknown;
  }
  // CSP-blocked: AST walk against resolved cels. Still beats today
  // because it skips Object.entries + per-fire cel lookups.
  return () => evaluateAgainstCels(ast, cels);
};

/** Parse a formula once; return the runtime body + buildEvaluate hook
 *  the kernel uses for the per-cel monomorphic closure path. */
export const compileFormula = (src: string): CompiledLambda => {
  const ast = parse(src);
  const fn: Fn = (inputs: Record<string, unknown>) => evaluate(ast, inputs);
  return {
    fn,
    buildEvaluate: (cels: ResolvedInputs) => buildEvaluateFor(ast, cels),
  };
};
