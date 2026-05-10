import type { Fn, LambdaKey, Segment, State } from "../../../../plastron/src/types/index.js";

// ========================================================================
// Counter segment — Fibonacci edition (formula-driven render).
//
// `count` is the position in the Fibonacci sequence. The +1 button
// advances by one. The render tree is composed entirely of formula
// cels referencing dom-builders (el, h2, p, button, obj, onDispatch,
// concat). Function values for fib + toChinese are exposed as cels
// so the formulas can call them directly.
//
// Sequence shown over successive clicks:
//   零, 一, 一, 二, 三, 五, 八, 十三, 二十一, 三十四, 五十五,
//   八十九, 一百四十四, 二百三十三, 三百七十七, 六百一十,
//   九百八十七, 一千五百九十七, …
// ========================================================================

export interface SegmentBundle {
  segment: Segment;
  fns: Map<LambdaKey, Fn>;
}

const fib = (n: number): number => {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
};

const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const PLACES = ["", "十", "百", "千"] as const;

const toChinese = (n: number): string => {
  if (n === 0) return "零";
  if (n < 0)  return "負" + toChinese(-n);
  if (n >= 100000000) {
    const yi = Math.floor(n / 100000000);
    const rest = n % 100000000;
    return toChinese(yi) + "億" + (rest === 0 ? "" : (rest < 10000000 ? "零" : "") + toChinese(rest));
  }
  if (n >= 10000) {
    const wan = Math.floor(n / 10000);
    const rest = n % 10000;
    return toChinese(wan) + "萬" + (rest === 0 ? "" : (rest < 1000 ? "零" : "") + toChinese(rest));
  }
  if (n >= 10 && n < 20) {
    return n === 10 ? "十" : "十" + DIGITS[n - 10]!;
  }
  let out = "";
  let pendingZero = false;
  for (let i = 3; i >= 0; i--) {
    const place = 10 ** i;
    const d = Math.floor(n / place) % 10;
    if (d > 0) {
      if (pendingZero) out += "零";
      out += DIGITS[d] + PLACES[i];
      pendingZero = false;
    } else if (out.length > 0) {
      pendingZero = true;
    }
  }
  return out;
};

// The action handler. Stays as JS — async cel mutation is the right
// shape for this and not what the formula language is for.
const increment: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  const cur = (state.cels.get("count")?.v as number | undefined) ?? 0;
  await (state.fns.get("set") as Fn)(state, "count", cur + 1);
};

// All render structure now lives in formula cels:
//
//   count       (data, number)
//   fib         (function value, exposed for formula reference)
//   toChinese   (function value, exposed for formula reference)
//   fibValue    formula  → fib(count)
//   chineseText formula  → toChinese(fibValue)
//   arabicText  formula  → "fib(count) = N"  (via concat)
//   counterTree formula  → composed VNode tree
//
// The whole render path is editable from a sheet — change a formula,
// the cascade recomputes the tree, plastron-dom paints. No render
// lambda; the structure IS the formulas.
export const counterSegment: SegmentBundle = {
  segment: {
    key: "counter",
    cels: [
      // Data
      { key: "count",     v: 0,         segment: "counter" },
      // Function values — formulas reference these as call heads
      { key: "fib",       v: fib,       segment: "counter" },
      { key: "toChinese", v: toChinese, segment: "counter" },
      // Computed values
      {
        key: "fibValue",
        l: "f",
        f: "(fib count)",
        segment: "counter",
      },
      {
        key: "chineseText",
        l: "f",
        f: "(toChinese fibValue)",
        segment: "counter",
      },
      {
        key: "arabicText",
        l: "f",
        f: '(concat "fib(" count ") = " fibValue)',
        segment: "counter",
      },
      // Per-element render formulas
      {
        key: "counterTitle",
        l: "f",
        f: '(dom "h2" null "Counter")',
        segment: "counter",
      },
      {
        key: "counterChinese",
        l: "f",
        f: '(dom "p" (obj "class" "count") chineseText)',
        segment: "counter",
      },
      {
        key: "counterArabic",
        l: "f",
        f: '(dom "p" (obj "class" "count-arabic") arabicText)',
        segment: "counter",
      },
      {
        key: "counterButton",
        l: "f",
        f: '(dom "button" (obj "onClick" (onDispatch "counter:increment")) "+1")',
        segment: "counter",
      },
      // Composed tree — read by the shell as the counter view.
      {
        key: "counterTree",
        l: "f",
        f: '(dom "section" (obj "class" "counter") counterTitle counterChinese counterArabic counterButton)',
        segment: "counter",
      },
    ],
  },
  fns: new Map<LambdaKey, Fn>([
    ["counter:increment", increment],
  ]),
};
