import type { Cel, CompiledLambda, ComputeCel, Fn, Key, ResolvedInputs, SExp } from "../types/index.js";

// Resolve a cel as a callable HEAD: LambdaCels expose their _fn;
// everything else uses .v. Lets a formula reference any callable cel
// (LockedLambda, EditableLambda, or a ValueCel whose v is a function)
// uniformly as the head of a list. FormulaCels at head position are
// degenerate (the formula language has no anonymous-formula concept)
// but the _fn ?? v pattern would pick the formula's compiled fn —
// not a useful value either way, so this resolves the same way.
const celHeadValue = (c: Cel): unknown => (c as ComputeCel)._fn ?? c.v;

// Resolve a cel as a VALUE referenced in argument position. Mirrors
// celHeadValue except FormulaCels are read through `.v` (their
// computed result) rather than `._fn` (their compiled formula
// function). Without this distinction, `(g f)` where `f` is a
// FormulaCel passes the *formula's compiled function* to `g` instead
// of f's most recent computed value — silently wrong, since `_fn`
// always exists on a hydrated FormulaCel.
const celArgValue = (c: Cel): unknown =>
  c.celType === "FormulaCel" ? c.v : (c as ComputeCel)._fn ?? c.v;

// ============================================================================
// S-expression formula parser + compiler.
//
// Grammar (informally):
//   expr = NUMBER | SYMBOL | '(' expr* ')'
//
// A list `(head arg1 arg2 …)` is a function call: look up `inputs[head]`
// (must be callable). Arithmetic operators (+ - * /) are nothing special
// at this layer — they live as LockedLambdaCels in the "builtins"
// segment and resolve the same way everything else does. Cels can hold
// function values directly (ValueCel.v = fn) or as LambdaCel._fn; both
// resolve through celValue().
//
// Every symbol — bare (`a`) or list head (`(myFn a b)`) — is a cel
// reference. Hydrate's auto-wire pulls every such symbol into inputMap.
//
// Numbers are JS floats. Non-numeric values flowing through arithmetic
// coerce via Number() and propagate NaN honestly.
//
// The codegen path keeps a small recognition table (BUILTIN_HEADS) so it
// can inline `(+ a b)` as `(Number(a)+Number(b))` rather than emit a
// function call. The cels still ship — they're the slow-path and
// bare-symbol resolution target. Flushing the builtins segment makes
// formulas that reach them via the slow path error cleanly.
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

// Codegen-only recognition set. Members get inlined as raw JS arithmetic
// by generateBody; non-members fall through to a cel-resolved fn call.
// The runtime impls live as cels in the "builtins" segment.
const BUILTIN_HEADS: ReadonlySet<string> = new Set(["+", "-", "*", "/"]);

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

  const fn = inputs[head];
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function.`);
  }
  return fn(...args);
};

/** Symbols referenced by the formula, in first-seen order. Every
 *  non-literal symbol — data refs, function refs, arithmetic operators
 *  alike — is returned for hydrate to auto-wire into inputMap. */
export const extractDeps = (src: string): Key[] => {
  const ast = parse(src);
  const seen = new Set<string>();
  const out: Key[] = [];
  const visit = (e: SExp): void => {
    if (typeof e === "string") {
      if (e === "null" || e === "true" || e === "false") return;
      if (isStringLit(e)) return;
      if (seen.has(e)) return;
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

// CSP / eval availability is sourced from the `csp.eval-available` cel
// (see 甲骨坑/csp.ts) and threaded down through buildEvaluateFor at
// precompute time. Callers pass the boolean explicitly so this module
// stays state-agnostic and the value is queryable for tests +
// diagnostics rather than buried in a module constant.

// Walk the AST against resolved cels — same shape as `evaluate` but
// reads cel values inline rather than from a pre-built inputs record.
// Used by buildEvaluate when codegen isn't available or the formula
// uses array-typed inputs (which the codegen path doesn't emit for).
const evaluateAgainstCels = (
  exp: SExp,
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
    if (Array.isArray(c)) return c.map((x) => x === undefined ? undefined : celArgValue(x));
    return celArgValue(c);
  }
  if (!Array.isArray(exp) || exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluateAgainstCels(a, cels));

  const c = cels[head];
  const fn = (c !== undefined && !Array.isArray(c)) ? celHeadValue(c) : undefined;
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function.`);
  }
  return (fn as (...a: unknown[]) => unknown)(...args);
};

// Generate a JS expression body for the AST. Each unique symbol becomes
// a closure parameter `c0`, `c1`, …; references in the expression read
// the cel's value. Function calls compile to a call on the cel's value.
// Builtins emit raw arithmetic with Number() coercion to preserve the
// interpreter's behavior on string inputs.
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

  // Two read forms — heads vs args. Heads need the callable: LambdaCels
  // expose it via _fn, ValueCels-with-fn via v, so `_fn ?? v` resolves
  // uniformly. Args want the cel's *value*: for ValueCels and
  // FormulaCels, that's c.v. For LambdaCels passed as values, c.v is
  // null and we need c._fn. The key wrinkle is FormulaCels: they have
  // *both* a compiled _fn (the formula function) and a v (the computed
  // result). Reading a FormulaCel as an arg with `_fn ?? v` returns the
  // wrong thing — the formula function instead of its current value.
  // celArgValue() in the AST-walk path does the celType check; here we
  // inline the equivalent so the codegen path matches semantically.
  const readHeadVar = (i: number): string => `(c${i}._fn??c${i}.v)`;
  const readArgVar  = (i: number): string =>
    `(c${i}.celType==="FormulaCel"?c${i}.v:(c${i}._fn??c${i}.v))`;

  const gen = (exp: SExp): string => {
    if (typeof exp === "number") return JSON.stringify(exp);
    if (typeof exp === "string") {
      if (exp === "null")  return "null";
      if (exp === "true")  return "true";
      if (exp === "false") return "false";
      // Re-encode through JSON.stringify so embedded newlines / quotes
      // produce valid JS source rather than raw control characters.
      if (isStringLit(exp)) return JSON.stringify(exp.slice(1, -1));
      return readArgVar(indexFor(exp));
    }
    if (!Array.isArray(exp) || exp.length === 0) return "null";

    const head = exp[0];
    if (typeof head !== "string") {
      throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
    }
    const args = exp.slice(1).map(gen);

    // Inline arithmetic operators as raw JS. Cels still need to be in
    // inputMap (extractDeps wires them) for dep tracking — the cel
    // resolution just isn't on the hot path for these heads.
    if (BUILTIN_HEADS.has(head)) {
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
    }
    return `${readHeadVar(indexFor(head))}(${args.join(",")})`;
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
  cels: ResolvedInputs,
  cspEvalAvailable: boolean,
): (() => unknown) => {
  if (cspEvalAvailable) {
    let body: string;
    let symbols: string[];
    try {
      ({ body, symbols } = generateBody(ast));
    } catch {
      // Codegen-side limitation (e.g. bare builtin) — fall through to
      // AST walk, which handles the same edge cases consistently.
      return () => evaluateAgainstCels(ast, cels);
    }
    // Codegen output assumes scalar inputs. If any input resolved to
    // an array, fall back to the AST walk which handles arrays correctly.
    if (hasArrayInput(cels, symbols)) {
      return () => evaluateAgainstCels(ast, cels);
    }
    const params = symbols.map((_, i) => `c${i}`);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      ...params,
      `"use strict"; return function evaluate() { return ${body}; };`,
    );
    const args: unknown[] = symbols.map((name) => cels[name] as Cel);
    return factory(...args) as () => unknown;
  }
  // CSP-blocked: AST walk against resolved cels.
  return () => evaluateAgainstCels(ast, cels);
};

/** Parse a formula once; return the runtime body + buildEvaluate hook
 *  the kernel uses for the per-cel monomorphic closure path. */
export const compileFormula = (src: string): CompiledLambda => {
  const ast = parse(src);
  const fn: Fn = (inputs: Record<string, unknown>) => evaluate(ast, inputs);
  return {
    fn,
    buildEvaluate: (cels: ResolvedInputs, cspEvalAvailable: boolean) =>
      buildEvaluateFor(ast, cels, cspEvalAvailable),
  };
};
