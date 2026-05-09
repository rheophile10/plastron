import type { Fn, LambdaKey, Segment, State } from "../../../../plastron/src/types/index.js";
import { el, type VNode } from "../../../../segments/plastron-dom/src/index.js";

// ========================================================================
// Counter segment — Fibonacci edition.
//
// `count` is the position in the Fibonacci sequence (0, 1, 2, 3, …).
// The +1 button advances by one step. The render lambda computes
// fib(count) and displays the result as a traditional Chinese numeral.
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

/** Iterative fibonacci. fib(0) = 0, fib(1) = 1, fib(2) = 1, … */
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

/** Convert n to a traditional Chinese numeral string for n ∈ [0, 99999999].
 *  Handles 萬 grouping; uses the colloquial "十二" form for 10–19. */
const toChinese = (n: number): string => {
  if (n === 0) return "零";
  if (n < 0)  return "負" + toChinese(-n);

  if (n >= 100000000) {
    // 億 grouping — fibonacci won't reach here in any reasonable click
    // budget, but keep the recursion total.
    const yi = Math.floor(n / 100000000);
    const rest = n % 100000000;
    return toChinese(yi) + "億" + (rest === 0 ? "" : (rest < 10000000 ? "零" : "") + toChinese(rest));
  }

  if (n >= 10000) {
    const wan = Math.floor(n / 10000);
    const rest = n % 10000;
    return toChinese(wan) + "萬" + (rest === 0 ? "" : (rest < 1000 ? "零" : "") + toChinese(rest));
  }

  // 0 < n < 10000.  10–19 takes the bare "十" prefix ("十一", "十二", …).
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

const renderCounter: Fn = ({ count }: { count: number }): VNode => {
  const value = fib(count);
  return el("section", { class: "counter" },
    el("h2", null, "Counter"),
    el("p", { class: "count" }, toChinese(value)),
    el("p", { class: "count-arabic" }, `fib(${count}) = ${value}`),
    el("button", { onClick: { dispatch: "counter:increment" } }, "+1"),
  );
};

const increment: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  const cur = (state.cels.get("count")?.v as number | undefined) ?? 0;
  await (state.fns.get("set") as Fn)(state, "count", cur + 1);
};

export const counterSegment: SegmentBundle = {
  segment: {
    key: "counter",
    cels: [
      { key: "count", v: 0, segment: "counter" },
      {
        key: "counterTree",
        l: "counter:renderCounter",
        inputMap: { count: "count" },
        segment: "counter",
      },
    ],
  },
  fns: new Map<LambdaKey, Fn>([
    ["counter:renderCounter", renderCounter],
    ["counter:increment", increment],
  ]),
};
