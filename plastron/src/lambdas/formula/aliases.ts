import type { LambdaKey } from "../types/lambda.js";

// Operator symbols and emojis → lambda keys. Read from the
// config_opAliases reserved cel at formula evaluation time.
export const defaultAliases: Record<string, LambdaKey> = {
  "+": "add", "-": "subtract", "*": "multiply", "/": "divide",
  "%": "modulo", "**": "power",
  "==": "eq", "===": "strictEq", "!=": "neq", "!==": "strictNeq",
  "<": "lt", ">": "gt", "<=": "lte", ">=": "gte",
  "&&": "and", "||": "or", "!": "not", "??": "nullish",
  "&": "bitAnd", "|": "bitOr", "^": "bitXor", "~": "bitNot",
  "<<": "lshift", ">>": "rshift", ">>>": "urshift",
  "➕": "add", "➖": "subtract", "✖️": "multiply", "➗": "divide",
  "🟰": "eq", "❓": "nullish",
  "📏": "mathMin", "📐": "mathMax",
  "⬆️": "mathCeil", "⬇️": "mathFloor", "🔄": "mathRound",
  "🔗": "concat", "🔍": "includes",
  "🔢": "toNumber", "📝": "toString", "✅": "toBoolean", "❔": "typeOf",
  ".": "get", ".:": "set", "?": "if",
  "#": "length", "..": "range", "++": "merge",
};
