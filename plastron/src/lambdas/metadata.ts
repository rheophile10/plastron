import type { LambdaKey, LambdaMetadata, Fn } from "./types/lambda.js";

import * as arithmetic from "./functions/arithmetic.js";
import * as comparison from "./functions/comparison.js";
import * as logical    from "./functions/logical.js";
import * as bitwise    from "./functions/bitwise.js";
import * as stringOps  from "./functions/string.js";
import * as coerce     from "./functions/coerce.js";
import * as math       from "./functions/math.js";
import * as objectOps  from "./functions/object.js";
import * as collection from "./functions/collection.js";
import * as misc       from "./functions/misc.js";

// ========================================================================
// Per-key metadata for the default operators. Paired with the raw
// function table below (opsFns) — hydrate attaches fn + meta separately
// to the cels that use them.
// ========================================================================

const arithM: Record<string, Omit<LambdaMetadata, "key">> = {
  add:      { filename: "functions/arithmetic.ts", description: "Add: a + b", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  subtract: { filename: "functions/arithmetic.ts", description: "Subtract: a - b", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  multiply: { filename: "functions/arithmetic.ts", description: "Multiply: a * b", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  divide:   { filename: "functions/arithmetic.ts", description: "Divide: a / b (null on /0)", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  modulo:   { filename: "functions/arithmetic.ts", description: "Modulo: a % b (null on /0)", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  power:    { filename: "functions/arithmetic.ts", description: "Power: a ** b", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
};

const compM: Record<string, Omit<LambdaMetadata, "key">> = {
  eq:        { filename: "functions/comparison.ts", description: "Equal (loose): a == b", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  strictEq:  { filename: "functions/comparison.ts", description: "Strict equal: a === b", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  neq:       { filename: "functions/comparison.ts", description: "Not equal (loose)", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  strictNeq: { filename: "functions/comparison.ts", description: "Strict not equal", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  lt:        { filename: "functions/comparison.ts", description: "Less than", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  gt:        { filename: "functions/comparison.ts", description: "Greater than", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  lte:       { filename: "functions/comparison.ts", description: "Less or equal", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  gte:       { filename: "functions/comparison.ts", description: "Greater or equal", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
};

const logicM: Record<string, Omit<LambdaMetadata, "key">> = {
  and:     { filename: "functions/logical.ts", description: "Logical AND (short-circuit)", inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  or:      { filename: "functions/logical.ts", description: "Logical OR (short-circuit)",  inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  not:     { filename: "functions/logical.ts", description: "Logical NOT",                 inputSchema: "unopInput",  outputSchema: "boolean", arity: 1 },
  nullish: { filename: "functions/logical.ts", description: "Nullish coalesce: a ?? b",    inputSchema: "binopInput", outputSchema: "object",  arity: 2 },
};

const bitM: Record<string, Omit<LambdaMetadata, "key">> = {
  bitAnd:  { filename: "functions/bitwise.ts", description: "Bitwise AND",             inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  bitOr:   { filename: "functions/bitwise.ts", description: "Bitwise OR",              inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  bitXor:  { filename: "functions/bitwise.ts", description: "Bitwise XOR",             inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  bitNot:  { filename: "functions/bitwise.ts", description: "Bitwise NOT",             inputSchema: "unopInput",  outputSchema: "number", arity: 1 },
  lshift:  { filename: "functions/bitwise.ts", description: "Left shift",              inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  rshift:  { filename: "functions/bitwise.ts", description: "Right shift (signed)",    inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  urshift: { filename: "functions/bitwise.ts", description: "Right shift (unsigned)",  inputSchema: "binopInput", outputSchema: "number", arity: 2 },
};

const stringM: Record<string, Omit<LambdaMetadata, "key">> = {
  concat:     { filename: "functions/string.ts", description: "String concat",           inputSchema: "binopInput", outputSchema: "string",  arity: 2 },
  includes:   { filename: "functions/string.ts", description: "String contains substr",  inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  startsWith: { filename: "functions/string.ts", description: "String startsWith",       inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
  endsWith:   { filename: "functions/string.ts", description: "String endsWith",         inputSchema: "binopInput", outputSchema: "boolean", arity: 2 },
};

const coerceM: Record<string, Omit<LambdaMetadata, "key">> = {
  toNumber:  { filename: "functions/coerce.ts", description: "Coerce to number",  inputSchema: "unopInput", outputSchema: "number",  arity: 1 },
  toString:  { filename: "functions/coerce.ts", description: "Coerce to string",  inputSchema: "unopInput", outputSchema: "string",  arity: 1 },
  toBoolean: { filename: "functions/coerce.ts", description: "Coerce to boolean", inputSchema: "unopInput", outputSchema: "boolean", arity: 1 },
  typeOf:    { filename: "functions/coerce.ts", description: "typeof operator",   inputSchema: "unopInput", outputSchema: "string",  arity: 1 },
};

const mathM: Record<string, Omit<LambdaMetadata, "key">> = {
  mathMin:   { filename: "functions/math.ts", description: "Math.min(a, b)", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  mathMax:   { filename: "functions/math.ts", description: "Math.max(a, b)", inputSchema: "binopInput", outputSchema: "number", arity: 2 },
  mathRound: { filename: "functions/math.ts", description: "Math.round(a)",  inputSchema: "unopInput",  outputSchema: "number", arity: 1 },
  mathFloor: { filename: "functions/math.ts", description: "Math.floor(a)",  inputSchema: "unopInput",  outputSchema: "number", arity: 1 },
  mathCeil:  { filename: "functions/math.ts", description: "Math.ceil(a)",   inputSchema: "unopInput",  outputSchema: "number", arity: 1 },
  mathAbs:   { filename: "functions/math.ts", description: "Math.abs(a)",    inputSchema: "unopInput",  outputSchema: "number", arity: 1 },
};

const objectM: Record<string, Omit<LambdaMetadata, "key">> = {
  get:     { filename: "functions/object.ts", description: "a?.[b]",              inputSchema: "binopInput",  outputSchema: "object",  arity: 2 },
  set:     { filename: "functions/object.ts", description: "{ ...a, [b]: c }",    inputSchema: "ternopInput", outputSchema: "object",  arity: 3 },
  keys:    { filename: "functions/object.ts", description: "Object.keys(a)",      inputSchema: "unopInput",   outputSchema: "array",   arity: 1 },
  values:  { filename: "functions/object.ts", description: "Object.values(a)",    inputSchema: "unopInput",   outputSchema: "array",   arity: 1 },
  entries: { filename: "functions/object.ts", description: "Object.entries(a)",   inputSchema: "unopInput",   outputSchema: "array",   arity: 1 },
  merge:   { filename: "functions/object.ts", description: "{ ...a, ...b }",      inputSchema: "binopInput",  outputSchema: "object",  arity: 2 },
  has:     { filename: "functions/object.ts", description: "b in a",              inputSchema: "binopInput",  outputSchema: "boolean", arity: 2 },
};

const collM: Record<string, Omit<LambdaMetadata, "key">> = {
  length:  { filename: "functions/collection.ts", description: "length of array/string/object", inputSchema: "unopInput",   outputSchema: "number", arity: 1 },
  range:   { filename: "functions/collection.ts", description: "[a, a+1, …, b-1]",              inputSchema: "binopInput",  outputSchema: "array",  arity: 2 },
  flatten: { filename: "functions/collection.ts", description: "Array.prototype.flat",          inputSchema: "unopInput",   outputSchema: "array",  arity: 1 },
  slice:   { filename: "functions/collection.ts", description: "a.slice(b, c)",                 inputSchema: "ternopInput", outputSchema: "object", arity: 3 },
  where:   { filename: "functions/collection.ts", description: "find item with [b]===c",         inputSchema: "ternopInput", outputSchema: "object", arity: 3 },
  pluck:   { filename: "functions/collection.ts", description: "map items -> item[b]",           inputSchema: "binopInput",  outputSchema: "array",  arity: 2 },
};

const miscM: Record<string, Omit<LambdaMetadata, "key">> = {
  join:  { filename: "functions/misc.ts", description: "Array.prototype.join", inputSchema: "binopInput",  outputSchema: "string", arity: 2 },
  split: { filename: "functions/misc.ts", description: "String.prototype.split", inputSchema: "binopInput", outputSchema: "array",  arity: 2 },
  if:    { filename: "functions/misc.ts", description: "a ? b : c",             inputSchema: "ternopInput", outputSchema: "object", arity: 3 },
  regex: { filename: "functions/misc.ts", description: "String match via RegExp(b)", inputSchema: "binopInput", outputSchema: "string", arity: 2 },
};

const opsMetaByKey: Record<string, Omit<LambdaMetadata, "key">> = {
  ...arithM, ...compM, ...logicM, ...bitM, ...stringM, ...coerceM, ...mathM,
  ...objectM, ...collM, ...miscM,
};

// ------------------------------------------------------------------------
// Raw function table — keyed by lambda key. Paired with opsMetaByKey to
// form the default exports in lambdas/index.ts.
// ------------------------------------------------------------------------

export const opsFns: Record<LambdaKey, Fn> = {
  ...arithmetic, ...comparison, ...logical, ...bitwise, ...stringOps,
  ...coerce, ...math, ...objectOps, ...collection, ...misc,
  if: misc.cond,   // alias: "if" key maps to cond fn
} as Record<LambdaKey, Fn>;

// ------------------------------------------------------------------------
// Build complete LambdaMetadata records — adds `key` and captures the
// function's stringified source so LLMs and dehydration can see it.
// ------------------------------------------------------------------------

export const opsMetadata: Record<LambdaKey, LambdaMetadata> = (() => {
  const out: Record<LambdaKey, LambdaMetadata> = {};
  for (const [key, meta] of Object.entries(opsMetaByKey)) {
    const fn = opsFns[key];
    if (!fn) throw new Error(`metadata.ts: no function registered for key "${key}"`);
    out[key] = { ...meta, key, source: fn.toString() };
  }
  return out;
})();
