import type { Fn, LambdaKey, LambdaMetadata } from "../types/lambda.js";
import type { Key } from "../../common.js";
import { opsFns, opsMetadata } from "../metadata.js";

// ========================================================================
// Expression parser + `f` lambda — the default formula evaluator.
//
// Syntax:
//   +(1, 2)                  binary call
//   if(cond, a, b)           ternary call
//   🔄(3.7)                  unary call via alias
//   [+](1, 2, 3, 4)          reduce
//   [100 +](10, 20)          reduce with accumulator
//   [1, 2, 3]                array literal
//   [1, 2, 3] |> +(1)        pipe map
//   [1, 2, 3, 4] |?> >(2)    pipe filter
//   [1, 2, 3, 4] |!> >(2)    pipe find
//   K("key") / @key          read another cel's value
// ========================================================================

interface EvalContext {
  fns: Record<LambdaKey, Fn>;
  metadata: Record<LambdaKey, LambdaMetadata>;
  aliases: Record<string, LambdaKey>;
  read: (key: Key) => unknown;
}

export const parseAndEval = async (input: string, ctx: EvalContext): Promise<unknown> => {
  let pos = 0;

  const peek = (): string => input[pos] ?? "";
  const at = (offset: number): string => input[pos + offset] ?? "";
  const skipWs = (): void => { while (pos < input.length && /\s/.test(input[pos])) pos++; };

  const parsePipeline = async (): Promise<unknown> => {
    let result = await parseExpr();
    skipWs();
    while (pos + 1 < input.length && input[pos] === "|") {
      if (input[pos + 1] === ">") { pos += 2; result = await parsePipeStep(result, "map"); }
      else if (input[pos + 1] === "?" && input[pos + 2] === ">") { pos += 3; result = await parsePipeStep(result, "filter"); }
      else if (input[pos + 1] === "!" && input[pos + 2] === ">") { pos += 3; result = await parsePipeStep(result, "find"); }
      else break;
      skipWs();
    }
    return result;
  };

  const parsePipeStep = async (piped: unknown, mode: "map" | "filter" | "find" = "map"): Promise<unknown> => {
    skipWs();
    if (peek() === "[") return parsePipeReduce(piped);
    const nameStart = pos;
    while (pos < input.length && input[pos] !== "(") pos++;
    const name = input.slice(nameStart, pos).trim();
    if (input[pos] !== "(") throw new Error(`Expected '(' in pipe step at ${pos}`);
    pos++;
    const extraArgs = await parseArgList();
    if (input[pos] !== ")") throw new Error(`Expected ')' at ${pos}`);
    pos++;

    if (mode === "map") {
      if (Array.isArray(piped)) {
        const results = [];
        for (const el of piped) results.push(await callFn(name, [el, ...extraArgs]));
        return results;
      }
      return callFn(name, [piped, ...extraArgs]);
    }
    const items = Array.isArray(piped) ? piped : [piped];
    if (mode === "filter") {
      const results = [];
      for (const el of items) if (await callFn(name, [el, ...extraArgs])) results.push(el);
      return results;
    }
    for (const el of items) if (await callFn(name, [el, ...extraArgs])) return el;
    return null;
  };

  const parsePipeReduce = async (piped: unknown): Promise<unknown> => {
    pos++;
    skipWs();
    const start = pos;
    while (pos < input.length && input[pos] !== "]") pos++;
    const spec = input.slice(start, pos).trim();
    pos++;

    let accumulator: unknown = undefined;
    let opName: string;
    const lastSpace = spec.lastIndexOf(" ");
    if (lastSpace > 0) {
      const accStr = spec.slice(0, lastSpace).trim();
      opName = spec.slice(lastSpace + 1).trim();
      accumulator = await parseAndEval(accStr, ctx);
    } else opName = spec;

    if (pos < input.length && input[pos] === "(") {
      pos++;
      await parseArgList();
      if (input[pos] !== ")") throw new Error(`Expected ')' at ${pos}`);
      pos++;
    }

    const values = Array.isArray(piped) ? piped : [piped];
    if (values.length === 0) return accumulator ?? null;

    let result: unknown = accumulator !== undefined ? accumulator : values[0];
    const startIdx = accumulator !== undefined ? 0 : 1;
    for (let i = startIdx; i < values.length; i++) result = await callFn(opName, [result, values[i]]);
    return result;
  };

  const parseExpr = async (): Promise<unknown> => {
    skipWs();
    if (pos >= input.length) return null;
    const ch = peek();

    if (ch === '"' || ch === "'") return parseString();
    if (input.startsWith("true", pos) && !/\w/.test(at(4))) { pos += 4; return true; }
    if (input.startsWith("false", pos) && !/\w/.test(at(5))) { pos += 5; return false; }
    if (input.startsWith("null", pos) && !/\w/.test(at(4))) { pos += 4; return null; }
    if (/\d/.test(ch) || (ch === "-" && /\d/.test(at(1)))) return parseNumber();
    if (ch === "[") return parseBracket();
    if (ch === "@") {
      pos++;
      const start = pos;
      while (pos < input.length && /[\w\-.]/.test(input[pos])) pos++;
      const key = input.slice(start, pos);
      if (!key) throw new Error(`Expected key after '@' at position ${pos}`);
      return ctx.read(key);
    }
    return parseFuncCall();
  };

  const parseNumber = (): number => {
    const start = pos;
    if (peek() === "-") pos++;
    while (pos < input.length && /[\d.]/.test(input[pos])) pos++;
    return Number(input.slice(start, pos));
  };

  const parseString = (): string => {
    const quote = input[pos++];
    let result = "";
    while (pos < input.length && input[pos] !== quote) {
      if (input[pos] === "\\") { pos++; result += input[pos] ?? ""; pos++; }
      else { result += input[pos]; pos++; }
    }
    pos++;
    return result;
  };

  const parseBracket = async (): Promise<unknown> => {
    pos++; skipWs();
    const savedPos = pos;
    let depth = 1, hasComma = false, scanPos = pos;
    while (scanPos < input.length && depth > 0) {
      if (input[scanPos] === "[") depth++;
      else if (input[scanPos] === "]") depth--;
      else if (input[scanPos] === "," && depth === 1) hasComma = true;
      else if (input[scanPos] === '"' || input[scanPos] === "'") {
        const q = input[scanPos]; scanPos++;
        while (scanPos < input.length && input[scanPos] !== q) { if (input[scanPos] === "\\") scanPos++; scanPos++; }
      }
      scanPos++;
    }
    pos = savedPos;

    if (hasComma) {
      const items: unknown[] = [];
      items.push(await parseExpr());
      skipWs();
      while (peek() === ",") { pos++; items.push(await parseExpr()); skipWs(); }
      if (peek() !== "]") throw new Error(`Expected ']' at ${pos}`);
      pos++;
      return items;
    }
    return parseReduce();
  };

  const parseReduce = async (): Promise<unknown> => {
    skipWs();
    const start = pos;
    while (pos < input.length && input[pos] !== "]") pos++;
    const spec = input.slice(start, pos).trim();
    pos++;

    let accumulator: unknown = undefined;
    let opName: string;
    const lastSpace = spec.lastIndexOf(" ");
    if (lastSpace > 0) {
      const accStr = spec.slice(0, lastSpace).trim();
      opName = spec.slice(lastSpace + 1).trim();
      accumulator = await parseAndEval(accStr, ctx);
    } else opName = spec;

    if (input[pos] !== "(") throw new Error(`Expected '(' after reduce spec at ${pos}`);
    pos++;
    const args = await parseArgList();
    if (input[pos] !== ")") throw new Error(`Expected ')' at ${pos}`);
    pos++;

    const values = args as unknown[];
    if (values.length === 0) return accumulator ?? null;
    let result: unknown = accumulator !== undefined ? accumulator : values[0];
    const startIdx = accumulator !== undefined ? 0 : 1;
    for (let i = startIdx; i < values.length; i++) result = await callFn(opName, [result, values[i]]);
    return result;
  };

  const parseFuncCall = async (): Promise<unknown> => {
    skipWs();
    const nameStart = pos;
    while (pos < input.length && input[pos] !== "(") pos++;
    const name = input.slice(nameStart, pos).trim();
    if (pos >= input.length || input[pos] !== "(") throw new Error(`Expected '(' after '${name}' at position ${pos}`);
    pos++;
    const args = await parseArgList();
    if (peek() !== ")") throw new Error(`Expected ')' at position ${pos}, got '${peek()}'`);
    pos++;

    const lambdaKey = name === "K" ? "K" : (ctx.aliases[name] ?? name);
    const arity = lambdaKey === "K" ? undefined : ctx.metadata[lambdaKey]?.arity;
    if (typeof arity === "number" && args.length !== arity) {
      throw new Error(
        `"${name}" has arity ${arity} but was called with ${args.length} arg${args.length === 1 ? "" : "s"}. ` +
        `Use [${name}](…) for explicit reduce, or correct the call.`
      );
    }
    return callFn(name, args);
  };

  const parseArgList = async (): Promise<unknown[]> => {
    const args: unknown[] = [];
    skipWs();
    if (peek() !== ")") {
      args.push(await parseExpr());
      skipWs();
      while (peek() === ",") { pos++; args.push(await parseExpr()); skipWs(); }
    }
    return args;
  };

  const callFn = async (name: string, args: unknown[]): Promise<unknown> => {
    if (name === "K") return ctx.read(String(args[0]));
    const lambdaKey = ctx.aliases[name] ?? name;
    if (lambdaKey === "f") throw new Error("Cannot call f recursively");
    const fn = ctx.fns[lambdaKey];
    if (!fn) throw new Error(`Unknown function: '${name}' (resolved: '${lambdaKey}')`);
    const arity = ctx.metadata[lambdaKey]?.arity;
    if (arity === 1) return Promise.resolve(fn({ a: args[0] }));
    if (arity === 2) return Promise.resolve(fn({ a: args[0], b: args[1] }));
    if (arity === 3) return Promise.resolve(fn({ a: args[0], b: args[1], c: args[2] }));
    return Promise.resolve(fn({ a: args[0], b: args[1], c: args[2] }));
  };

  const result = await parsePipeline();
  skipWs();
  if (pos < input.length) throw new Error(`Unexpected characters at position ${pos}: '${input.slice(pos)}'`);
  return result;
};

// ========================================================================
// Dep extractor — used at hydrate time to auto-wire formula cels.
// ========================================================================

const extractFormulaDeps = (formula: string): Key[] => {
  const deps = new Set<Key>();
  for (const m of formula.matchAll(/\bK\(\s*["']([^"']+)["']\s*\)/g)) deps.add(m[1]);
  for (const m of formula.matchAll(/@([\w\-.]+)/g)) deps.add(m[1]);
  return [...deps];
};

// ========================================================================
// f — the formula-evaluator function + its metadata. Aggregated with the
// operator bundle in lambdas/index.ts.
//
// fFn.extractDeps is attached as a property so hydrate can discover the
// parser's dep-extraction capability by looking at the fn itself.
// ========================================================================

const fFnImpl = async (
  input: Record<string, unknown> & { f: string; _read: (key: Key) => unknown; _prev?: unknown[] },
): Promise<unknown> => {
  const formula = input.f;
  if (typeof formula !== "string") return null;

  const preResolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("__dep_")) preResolved[k.slice("__dep_".length)] = v;
  }

  const aliases = (input._read("config_opAliases") ?? {}) as Record<string, string>;
  const read = (key: Key): unknown => {
    if (key in preResolved) return preResolved[key];
    return input._read(key);
  };

  const ctx: EvalContext = {
    fns: opsFns,
    metadata: opsMetadata,
    aliases,
    read,
  };
  return parseAndEval(formula, ctx);
};

export const fFn: Fn = Object.assign(fFnImpl as Fn, {
  extractDeps: extractFormulaDeps,
});

export const fMetadata: LambdaMetadata = {
  key: "f",
  filename: "formula.ts",
  description: "Default formula evaluator. Parses Polish-notation expressions, @key cel lookup, variadic reduce via [op](…).",
  inputSchema: "object",
  outputSchema: "object",
  source: fFnImpl.toString(),
};
