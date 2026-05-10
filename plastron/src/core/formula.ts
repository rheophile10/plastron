import type { Cel, CompiledLambda, Fn, Key, ResolvedInputs, State } from "../types/index.js";
import { resolveValue } from "./refs.js";

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
//                     Both paths emit ref-aware reads: every cel-value
//                     access goes through `(c.ref ? resolveValue(state,
//                     c) : c.v)`, mirroring the slow-gather path in
//                     runCycle.ts. This lets a downstream formula keep
//                     the codegen fast path even after one of its inputs
//                     was consolidated into a Column / Matrix / Table
//                     and turned into a ref cel — the central
//                     transparency promise of cel-refs.
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

// Tokenizer with string-literal support. Strings are double-quoted and
// support `\\`, `\"`, `\n`, `\t`, `\r` escapes. The decoded contents
// are returned as a single token with the quotes preserved (the parser
// uses the leading `"` as the marker that distinguishes a literal from
// a symbol). Whitespace, parens, and `"` are token boundaries; nothing
// else is. Bare atoms `null`, `true`, `false` get their JS-equivalent
// values at evaluate / codegen time — they collide with cel keys of
// the same name, but reserving those words is the standard cost.
const tokenize = (src: string): string[] => {
  const tokens: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '"';
      let closed = false;
      while (j < n) {
        const k = src[j]!;
        if (k === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === "r") s += "\r";
          else s += e;            // covers \\, \", and any other passthrough
          j += 2;
          continue;
        }
        if (k === '"') { s += '"'; j++; closed = true; break; }
        s += k;
        j++;
      }
      if (!closed) throw new Error(`Unterminated string in formula "${src}"`);
      tokens.push(s);
      i = j;
      continue;
    }
    // Bare atom — symbol, number, or reserved literal (null/true/false).
    let j = i;
    while (j < n) {
      const k = src[j]!;
      if (k === " " || k === "\t" || k === "\n" || k === "\r" ||
          k === "(" || k === ")" || k === '"') break;
      j++;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
};

// Helpers for the literal-detection sigils used in SExp strings.
const isStringLit = (s: string): boolean =>
  s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34;

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
  if (typeof exp === "string") {
    if (exp === "null")  return null;
    if (exp === "true")  return true;
    if (exp === "false") return false;
    if (isStringLit(exp)) return exp.slice(1, -1);
    return inputs[exp];
  }
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
      if (e === "null" || e === "true" || e === "false") return;
      if (isStringLit(e)) return;
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

// Read a single cel through any ref. Mirrors the runCycle slow-gather
// pattern (`cs?.ref ? resolveValue(state, cs) : cs.v`) so the AST-walk
// and codegen paths agree on ref semantics — codegen below inlines the
// same expression directly into emitted JS to avoid the call overhead
// on the hot path. Used by the AST-walk fallback only.
const readCelValue = (state: State, cel: Cel | undefined): unknown => {
  if (cel === undefined) return undefined;
  if (cel.ref) return resolveValue(state, cel);
  return cel.v;
};

// Walk the AST against resolved cels — same shape as `evaluate` but
// reads cel values inline rather than from a pre-built inputs record.
// Used by buildEvaluate when codegen isn't available or the formula
// uses array-typed inputs (which the codegen path doesn't emit for).
// Inputs that resolved to ref cels are read through resolveValue so
// downstream formulas keep working transparently when an upstream
// value was consolidated into a column / matrix / table.
const evaluateAgainstCels = (
  exp: SExp,
  state: State,
  cels: ResolvedInputs,
): unknown => {
  if (typeof exp === "number") return exp;
  if (typeof exp === "string") {
    if (exp === "null")  return null;
    if (exp === "true")  return true;
    if (exp === "false") return false;
    if (isStringLit(exp)) return exp.slice(1, -1);
    const c = cels[exp];
    if (c === undefined) return undefined;
    if (Array.isArray(c)) return c.map((x) => readCelValue(state, x));
    return readCelValue(state, c);
  }
  if (!Array.isArray(exp) || exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluateAgainstCels(a, state, cels));

  if (head in BUILTINS) return BUILTINS[head](args);

  const c = cels[head];
  const fn = (c !== undefined && !Array.isArray(c)) ? readCelValue(state, c) : undefined;
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function or builtin.`);
  }
  return (fn as (...a: unknown[]) => unknown)(...args);
};

// Generate a JS expression body for the AST. Each unique symbol becomes
// a closure parameter `c0`, `c1`, …; references in the expression read
// the cel's value. Function calls compile to a call on the cel's value.
// Builtins emit raw arithmetic with Number() coercion to preserve the
// interpreter's behavior on string inputs.
//
// Ref-aware reads: every emitted value read goes through
// `(cN.ref?_r(_s,cN):cN.v)` rather than a bare `cN.v`. The check is one
// property load on the no-ref hot path (branch-predictable, JIT-inlined)
// and resolves through `resolveValue(state, cN)` only when the input is
// a ref cel. `_r` and `_s` are extra captured params injected by
// buildEvaluateFor below — `_r` is `resolveValue` and `_s` is the live
// state. This is the codegen counterpart to the slow-gather path's
// `cs?.ref ? resolveValue(state, cs) : cs.v` in runCycle.ts; without it,
// consolidating any upstream value would silently disable the codegen
// fast path for every formula that reads it.
const generateBody = (
  ast: SExp,
): { body: string; symbols: string[] } => {
  const symbols: string[] = [];
  const symbolIndex = new Map<string, number>();
  const indexFor = (name: string): number => {
    let i = symbols.length;
    const existing = symbolIndex.get(name);
    if (existing !== undefined) return existing;
    symbolIndex.set(name, i);
    symbols.push(name);
    return i;
  };

  const readVar = (i: number): string => `(c${i}.ref?_r(_s,c${i}):c${i}.v)`;

  const gen = (exp: SExp): string => {
    if (typeof exp === "number") return JSON.stringify(exp);
    if (typeof exp === "string") {
      if (exp === "null")  return "null";
      if (exp === "true")  return "true";
      if (exp === "false") return "false";
      // Re-encode through JSON.stringify so embedded newlines / quotes
      // produce valid JS source rather than raw control characters.
      if (isStringLit(exp)) return JSON.stringify(exp.slice(1, -1));
      if (exp in BUILTINS) {
        // Builtin appearing bare (not as list head) is degenerate.
        // Fall back to AST walk for this formula by signalling.
        throw new Error(`Builtin "${exp}" used as a value`);
      }
      return readVar(indexFor(exp));
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
    return `${readVar(indexFor(head))}(${args.join(",")})`;
  };

  return { body: gen(ast), symbols };
};

const hasArrayInput = (cels: ResolvedInputs, symbols: string[]): boolean => {
  for (const name of symbols) {
    if (Array.isArray(cels[name])) return true;
  }
  return false;
};

const buildEvaluateFor = (
  ast: SExp,
  state: State,
  cels: ResolvedInputs,
): (() => unknown) => {
  if (CODEGEN_AVAILABLE) {
    let body: string;
    let symbols: string[];
    try {
      ({ body, symbols } = generateBody(ast));
    } catch {
      // Codegen-side limitation (e.g. bare builtin) — fall through to
      // AST walk, which handles the same edge cases consistently.
      return () => evaluateAgainstCels(ast, state, cels);
    }
    // Codegen output assumes scalar refs. If any input resolved to an
    // array, fall back to the AST walk which handles arrays correctly.
    if (hasArrayInput(cels, symbols)) {
      return () => evaluateAgainstCels(ast, state, cels);
    }
    // Param order: cN bindings first, then `_r` (resolveValue) and `_s`
    // (state). Captured by the factory so the emitted body can inline
    // the ref check `(cN.ref?_r(_s,cN):cN.v)` without per-fire lookups.
    const params = symbols.map((_, i) => `c${i}`);
    params.push("_r", "_s");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      ...params,
      `"use strict"; return function evaluate() { return ${body}; };`,
    );
    const args: unknown[] = symbols.map((name) => cels[name]);
    args.push(resolveValue, state);
    return factory(...args) as () => unknown;
  }
  // CSP-blocked: AST walk against resolved cels. Still beats today
  // because it skips Object.entries + per-fire cel lookups.
  return () => evaluateAgainstCels(ast, state, cels);
};

/** Parse a formula once; return the runtime body + buildEvaluate hook
 *  the kernel uses for the per-cel monomorphic closure path. */
export const compileFormula = (src: string): CompiledLambda => {
  const ast = parse(src);
  const fn: Fn = (inputs: Record<string, unknown>) => evaluate(ast, inputs);
  return {
    fn,
    buildEvaluate: (state: State, cels: ResolvedInputs) =>
      buildEvaluateFor(ast, state, cels),
  };
};
