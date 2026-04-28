// ============================================================================
// A tiny MS-Excel-like formula parser for cel.f. Registered as a
// plastron lambda so it can drive formula cels.
//
// Supported syntax:
//   =A1               cell reference
//   =A1+B1*C1         arithmetic (+, -, *, /) with precedence
//   =(A1+B1)*C1       parentheses
//   =A1=5             equality         (single =, not ==)
//   =A1<>5            inequality
//   =A1<5 / >= / <=   comparisons
//   =A1&B1            string concat
//   =SUM(A1,A2,A3)    function calls (variadic)
//   =IF(cond, a, b)   if function
//   =AVERAGE(A1,A2)   built-in aggregators
//   =MIN/MAX/ROUND/CONCAT/LEN/UPPER/LOWER
//   "literal"         string literals
//   42, 3.14          number literals
//   TRUE / FALSE      boolean literals
//
// NOT supported: ranges (A1:A5), sheet refs (Sheet1!A1), array formulas.
// ============================================================================

import type { Fn, LambdaKey, LambdaMetadata } from "../../plastron/src/lambdas/types/lambda.js";
import type { Key } from "../../plastron/src/common.js";

type Refs = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Excel function table. Args are already-evaluated values.
// ---------------------------------------------------------------------------

const excelFns: Record<string, (args: unknown[]) => unknown> = {
  SUM:      args => args.reduce<number>((a, b) => a + Number(b), 0),
  AVERAGE:  args => args.reduce<number>((a, b) => a + Number(b), 0) / args.length,
  MIN:      args => Math.min(...args.map(Number)),
  MAX:      args => Math.max(...args.map(Number)),
  ROUND:    args => Math.round(Number(args[0])),
  ABS:      args => Math.abs(Number(args[0])),
  IF:       args => args[0] ? args[1] : args[2],
  CONCAT:   args => args.map(String).join(""),
  LEN:      args => String(args[0]).length,
  UPPER:    args => String(args[0]).toUpperCase(),
  LOWER:    args => String(args[0]).toLowerCase(),
  COUNT:    args => args.length,
};

// ---------------------------------------------------------------------------
// Recursive-descent evaluator. Tokenizes on the fly.
// ---------------------------------------------------------------------------

const evalExcel = (src: string, refs: Refs): unknown => {
  const input = src.startsWith("=") ? src.slice(1) : src;
  let pos = 0;
  const peek = () => input[pos];
  const skipWs = () => { while (pos < input.length && /\s/.test(input[pos])) pos++; };

  const readWhile = (re: RegExp): string => {
    const s = pos;
    while (pos < input.length && re.test(input[pos])) pos++;
    return input.slice(s, pos);
  };

  const parseExpr     = (): unknown => parseCompare();
  const parseCompare  = (): unknown => {
    let left = parseAddSub();
    skipWs();
    while (pos < input.length) {
      skipWs();
      const c1 = peek();
      const c2 = input[pos + 1];
      if (c1 === "<" && c2 === ">") { pos += 2; left = left !== parseAddSub();    skipWs(); }
      else if (c1 === "<" && c2 === "=") { pos += 2; left = Number(left) <= Number(parseAddSub()); skipWs(); }
      else if (c1 === ">" && c2 === "=") { pos += 2; left = Number(left) >= Number(parseAddSub()); skipWs(); }
      else if (c1 === "<")  { pos += 1; left = Number(left) <  Number(parseAddSub()); skipWs(); }
      else if (c1 === ">")  { pos += 1; left = Number(left) >  Number(parseAddSub()); skipWs(); }
      else if (c1 === "=")  { pos += 1; left = left === parseAddSub();    skipWs(); }
      else break;
    }
    return left;
  };

  const parseAddSub = (): unknown => {
    let left = parseMulDiv();
    skipWs();
    while (peek() === "+" || peek() === "-" || peek() === "&") {
      const op = input[pos++];
      skipWs();
      const right = parseMulDiv();
      if (op === "+")      left = Number(left) + Number(right);
      else if (op === "-") left = Number(left) - Number(right);
      else                 left = String(left) + String(right);   // &
      skipWs();
    }
    return left;
  };

  const parseMulDiv = (): unknown => {
    let left = parsePrimary();
    skipWs();
    while (peek() === "*" || peek() === "/") {
      const op = input[pos++];
      skipWs();
      const right = parsePrimary();
      left = op === "*" ? Number(left) * Number(right) : Number(left) / Number(right);
      skipWs();
    }
    return left;
  };

  const parsePrimary = (): unknown => {
    skipWs();
    const ch = peek();

    // Parenthesised subexpression
    if (ch === "(") {
      pos++;
      const inner = parseExpr();
      skipWs();
      if (peek() !== ")") throw new Error(`Expected ')' at position ${pos}`);
      pos++;
      return inner;
    }

    // String literal
    if (ch === '"') {
      pos++;
      let out = "";
      while (pos < input.length && input[pos] !== '"') out += input[pos++];
      pos++;
      return out;
    }

    // Number literal
    if (/[0-9.]/.test(ch) || (ch === "-" && /[0-9.]/.test(input[pos + 1]))) {
      const sign = ch === "-" ? (pos++, -1) : 1;
      const num = readWhile(/[0-9.]/);
      return sign * Number(num);
    }

    // Identifier — either a cell reference, a boolean literal, or a function call
    if (/[A-Za-z]/.test(ch)) {
      const name = readWhile(/[A-Za-z0-9_]/);
      skipWs();

      // Boolean literals
      if (name === "TRUE")  return true;
      if (name === "FALSE") return false;

      // Function call?
      if (peek() === "(") {
        pos++;
        const args: unknown[] = [];
        skipWs();
        if (peek() !== ")") {
          args.push(parseExpr());
          skipWs();
          while (peek() === ",") { pos++; skipWs(); args.push(parseExpr()); skipWs(); }
        }
        if (peek() !== ")") throw new Error(`Expected ')' after ${name}( at ${pos}`);
        pos++;
        const fn = excelFns[name.toUpperCase()];
        if (!fn) throw new Error(`Unknown Excel function: ${name}`);
        return fn(args);
      }

      // Cell reference — read the value out of refs (provided by the engine
      // via __dep_<key> injected inputs).
      if (!(name in refs)) throw new Error(`Unknown cell reference: ${name}`);
      return refs[name];
    }

    throw new Error(`Unexpected character '${ch}' at position ${pos}`);
  };

  skipWs();
  const result = parseExpr();
  skipWs();
  if (pos < input.length) throw new Error(`Trailing input at position ${pos}: '${input.slice(pos)}'`);
  return result;
};

// ---------------------------------------------------------------------------
// Dep extractor — returns every cell reference used in the formula,
// excluding function names and keywords.
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  "TRUE", "FALSE",
  ...Object.keys(excelFns),
]);

const extractExcelDeps = (formula: string): Key[] => {
  const deps = new Set<Key>();
  const src = formula.startsWith("=") ? formula.slice(1) : formula;
  // Strip string literals first so identifiers inside quotes aren't captured.
  const stripped = src.replace(/"[^"]*"/g, "");
  for (const m of stripped.matchAll(/([A-Za-z][A-Za-z0-9_]*)/g)) {
    const name = m[1];
    // Skip if followed by '(' (it's a function call)
    const after = stripped[m.index! + name.length];
    if (after === "(") continue;
    if (RESERVED.has(name.toUpperCase())) continue;
    deps.add(name);
  }
  return [...deps];
};

// ---------------------------------------------------------------------------
// The Excel parser lambda + its metadata. extractDeps is attached as a
// property on the fn so hydrate can find it during formula expansion.
// ---------------------------------------------------------------------------

const excelLambdaImpl = (
  input: Record<string, unknown> & { f: string },
): unknown => {
  const formula = input.f;
  if (typeof formula !== "string") return null;

  const refs: Refs = {};
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("__dep_")) refs[k.slice("__dep_".length)] = v;
  }

  return evalExcel(formula, refs);
};

export const excel: Fn = Object.assign(excelLambdaImpl as Fn, {
  extractDeps: extractExcelDeps,
});

export const excelMeta: LambdaMetadata = {
  key:          "excel",
  name:         "excel",
  description:  "MS-Excel-style formula parser. Supports cell refs, arithmetic, comparisons, SUM/IF/AVERAGE/etc.",
  inputSchema:  "object",
  outputSchema: "object",
  source:       excelLambdaImpl.toString(),
};
