import { test } from "bun:test";
import assert from "node:assert/strict";
import { topoLevels, dependentOrderFrom, transitiveClosure } from "../dist/kernel/topo.js";

// ============================================================================
// Direct coverage of the shared topo helper extracted from precompute.ts
// and segments.ts. See docs/1-design/3-accepted/00-ontology/
// segment-classification.md "Shared topo helper".
// ============================================================================

test("topoLevels: linear chain a → b → c yields three levels", () => {
  const upstream = new Map([["a", []], ["b", ["a"]], ["c", ["b"]]]);
  const levels = topoLevels(["a", "b", "c"], (n) => upstream.get(n) ?? []);
  assert.deepEqual(levels, [["a"], ["b"], ["c"]]);
});

test("topoLevels: parallel branches in one level", () => {
  // a is the root; b and c both depend on a; d depends on both.
  const upstream = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["a"]],
    ["d", ["b", "c"]],
  ]);
  const levels = topoLevels(["a", "b", "c", "d"], (n) => upstream.get(n) ?? []);
  assert.equal(levels.length, 3);
  assert.deepEqual(levels[0], ["a"]);
  assert.deepEqual(new Set(levels[1]), new Set(["b", "c"]));
  assert.deepEqual(levels[2], ["d"]);
});

test("topoLevels: memberSet filter ignores out-of-set upstreams", () => {
  // x is outside the member set; b's claimed upstream on x should be ignored.
  const upstream = new Map([
    ["a", []],
    ["b", ["a", "x"]],
  ]);
  const memberSet = new Set(["a", "b"]);
  const levels = topoLevels(
    ["a", "b"],
    (n) => upstream.get(n) ?? [],
    { memberSet },
  );
  assert.deepEqual(levels, [["a"], ["b"]]);
});

test("topoLevels: throws on cycle with .cycle property", () => {
  const upstream = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  try {
    topoLevels(["a", "b"], (n) => upstream.get(n) ?? []);
    assert.fail("expected throw");
  } catch (e) {
    assert.match(e.message, /Dependency cycle/);
    assert.deepEqual(new Set(e.cycle), new Set(["a", "b"]));
  }
});

test("topoLevels: empty node set returns empty levels", () => {
  const levels = topoLevels([], () => []);
  assert.deepEqual(levels, []);
});

test("topoLevels: custom cycleMessagePrefix", () => {
  const upstream = new Map([["a", ["a"]]]);
  try {
    topoLevels(["a"], (n) => upstream.get(n) ?? [], {
      cycleMessagePrefix: "Cel cascade cycle",
    });
    assert.fail("expected throw");
  } catch (e) {
    assert.match(e.message, /^Cel cascade cycle/);
  }
});

test("dependentOrderFrom: dependents-first order from root", () => {
  // a → b → c (b depends on a, c depends on b).
  // Reverse adjacency: a's dependents = [b]; b's dependents = [c].
  const reverse = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
  ]);
  const order = dependentOrderFrom("a", reverse);
  // Root excluded; deepest dependent first.
  assert.deepEqual(order, ["c", "b"]);
});

test("dependentOrderFrom: parallel dependents emit deepest-first", () => {
  // a → b; a → c; both b and c are leaves.
  const reverse = new Map([
    ["a", ["b", "c"]],
  ]);
  const order = dependentOrderFrom("a", reverse);
  // Either ["b", "c"] or ["c", "b"] is valid (both are leaves).
  assert.equal(order.length, 2);
  assert.deepEqual(new Set(order), new Set(["b", "c"]));
});

test("dependentOrderFrom: no dependents → empty list", () => {
  const reverse = new Map();
  assert.deepEqual(dependentOrderFrom("solo", reverse), []);
});

test("transitiveClosure: walks forward closure including roots", () => {
  // Roots: {a}. Deps: a → b, b → c, c → (nothing).
  const deps = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
  ]);
  const closure = transitiveClosure(["a"], (n) => deps.get(n) ?? []);
  assert.deepEqual(new Set(closure), new Set(["a", "b", "c"]));
});

test("transitiveClosure: multiple roots union dedupes", () => {
  const deps = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["x", ["b"]],
  ]);
  const closure = transitiveClosure(["a", "x"], (n) => deps.get(n) ?? []);
  assert.deepEqual(new Set(closure), new Set(["a", "x", "b", "c"]));
});

test("transitiveClosure: cycles don't loop forever", () => {
  const deps = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  const closure = transitiveClosure(["a"], (n) => deps.get(n) ?? []);
  assert.deepEqual(new Set(closure), new Set(["a", "b"]));
});
