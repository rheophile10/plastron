import type { 甲骨, Cel, DehydratedCel, Fn, Key } from "../types/index.js";
import { inflateCel } from "../kernel/lifecycle/index.js";

import schemaSegment from "./js-common-schema.json" with { type: "json" };

// ============================================================================
// js-common-schema — protocol implementations for 12 base JavaScript types.
//
// Pairs with js-common-schema.json, which holds the declarative catalog:
// one SchemaCel per type (carrying JSON Schema in v.zod and fn-key refs in
// v.protocols), plus three LockedLambdaCels per type (isChanged, hydrate,
// dehydrate). The JSON is data — kind: "native", no source body.
//
// This file owns the runtime side:
//
//   • Implementations of all 36 protocol fns. Names match cel keys exactly
//     so the loader can bind by key (`string` → string_isChanged,
//     string_hydrate, string_dehydrate).
//   • commonSchemaFns: the Map<Key, Fn> the loader binds from.
//   • code-seed exports `cels: Cel[]` with lambda cels' _fn pre-bound,
//     so the schema-protocol dispatch (runCycle's resolveFn(state,
//     isChangedKey)) resolves them through the cel registry.
//
// Protocol semantics (uniform across types):
//
//   • isChanged(prev, next) → boolean.  True iff prev !≡ next in the
//     type's natural sense (Object.is for numbers, byte equality for
//     Uint8Array, source+flags for RegExp, …). Reference-only fast path
//     short-circuits at the top of every implementation.
//   • hydrate(v) → live JS value.  Identity for primitives. Date,
//     RegExp, Map, Set, Uint8Array each round-trip through a
//     JSON-friendly form (ISO string, {source,flags}, [[k,v],…], [...],
//     base64) and reconstruct the live instance here.
//   • dehydrate(v) → JSON value.  Symmetric inverse.
// ============================================================================

// ── string ──────────────────────────────────────────────────────────────────

export const string_isChanged: Fn = (a, b) => a !== b;
export const string_hydrate:   Fn = (v) => v;
export const string_dehydrate: Fn = (v) => v;

// ── number ──────────────────────────────────────────────────────────────────

// Object.is so NaN !== NaN doesn't mask a value swap, and +0 / -0 don't
// register as changes for code that didn't ask about sign.
export const number_isChanged: Fn = (a, b) => !Object.is(a, b);
export const number_hydrate:   Fn = (v) => v;
export const number_dehydrate: Fn = (v) => v;

// ── boolean ─────────────────────────────────────────────────────────────────

export const boolean_isChanged: Fn = (a, b) => a !== b;
export const boolean_hydrate:   Fn = (v) => v;
export const boolean_dehydrate: Fn = (v) => v;

// ── bigint ──────────────────────────────────────────────────────────────────

// JSON has no bigint — encoded as a decimal string. hydrate parses;
// dehydrate emits via .toString(). Primitive equality works on bigints.
export const bigint_isChanged: Fn = (a, b) => a !== b;
export const bigint_hydrate:   Fn = (v) => typeof v === "string" ? BigInt(v) : v;
export const bigint_dehydrate: Fn = (v) => typeof v === "bigint" ? v.toString() : v;

// ── null ────────────────────────────────────────────────────────────────────

// null vs null is never a change; null vs anything else always is.
export const null_isChanged: Fn = (a, b) => (a === null) !== (b === null);
export const null_hydrate:   Fn = (v) => v;
export const null_dehydrate: Fn = (v) => v;

// ── array ───────────────────────────────────────────────────────────────────

// Shallow equality only — element identity decides materiality. Nested
// structural diffs are the consuming code's problem (or a richer type).
export const array_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return true;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
};
export const array_hydrate:   Fn = (v) => Array.isArray(v) ? v : [];
export const array_dehydrate: Fn = (v) => Array.isArray(v) ? v : [];

// ── object (plain Record) ───────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const object_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return true;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return true;
  for (const k of ak) if (a[k] !== b[k]) return true;
  return false;
};
export const object_hydrate:   Fn = (v) => v;
export const object_dehydrate: Fn = (v) => v;

// ── date ────────────────────────────────────────────────────────────────────

export const date_isChanged: Fn = (a, b) => {
  const at = a instanceof Date ? a.getTime() : NaN;
  const bt = b instanceof Date ? b.getTime() : NaN;
  return !Object.is(at, bt);
};
export const date_hydrate:   Fn = (v) => (typeof v === "string" || typeof v === "number") ? new Date(v) : v;
export const date_dehydrate: Fn = (v) => v instanceof Date ? v.toISOString() : v;

// ── map ─────────────────────────────────────────────────────────────────────

// Serialized as an array of [key, value] pairs — JSON-friendly and
// preserves insertion order. Keys are themselves dehydrated as their
// natural JSON form (strings work transparently; structured keys need a
// custom schema).
export const map_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!(a instanceof Map) || !(b instanceof Map)) return true;
  if (a.size !== b.size) return true;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return true;
  return false;
};
export const map_hydrate:   Fn = (v) =>
  Array.isArray(v) ? new Map(v as Array<[unknown, unknown]>) : v;
export const map_dehydrate: Fn = (v) =>
  v instanceof Map ? Array.from(v.entries()) : v;

// ── set ─────────────────────────────────────────────────────────────────────

export const set_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!(a instanceof Set) || !(b instanceof Set)) return true;
  if (a.size !== b.size) return true;
  for (const v of a) if (!b.has(v)) return true;
  return false;
};
export const set_hydrate:   Fn = (v) => Array.isArray(v) ? new Set(v) : v;
export const set_dehydrate: Fn = (v) => v instanceof Set ? Array.from(v) : v;

// ── regexp ──────────────────────────────────────────────────────────────────

// Serialized as { source, flags }. The lastIndex of a stateful regexp is
// not preserved — that's by design; lastIndex is per-execution scratch,
// not part of the regexp's identity.
export const regexp_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!(a instanceof RegExp) || !(b instanceof RegExp)) return true;
  return a.source !== b.source || a.flags !== b.flags;
};
export const regexp_hydrate: Fn = (v) => {
  if (v && typeof v === "object" && "source" in v && "flags" in v) {
    return new RegExp(
      (v as { source: string }).source,
      (v as { flags: string }).flags,
    );
  }
  return v;
};
export const regexp_dehydrate: Fn = (v) =>
  v instanceof RegExp ? { source: v.source, flags: v.flags } : v;

// ── uint8array ──────────────────────────────────────────────────────────────

// Serialized as base64 strings — compact and JSON-friendly. atob/btoa
// are available in modern Node (>=16) and every browser; if neither is
// present, a host-side polyfill is on the caller. We reach through
// globalThis so tsconfig "lib": ["ES2023"] (no DOM) still type-checks.
const _btoa = (globalThis as { btoa?: (s: string) => string }).btoa
  ?? ((s: string) => { throw new Error(`btoa unavailable: cannot encode ${s.length} bytes`); });
const _atob = (globalThis as { atob?: (s: string) => string }).atob
  ?? ((s: string) => { throw new Error(`atob unavailable: cannot decode ${s.length} chars`); });
const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return _btoa(s);
};
const fromBase64 = (b64: string): Uint8Array => {
  const s = _atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
export const uint8array_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return true;
  if (a.byteLength !== b.byteLength) return true;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return true;
  return false;
};
export const uint8array_hydrate:   Fn = (v) =>
  typeof v === "string" ? fromBase64(v) : v;
export const uint8array_dehydrate: Fn = (v) =>
  v instanceof Uint8Array ? toBase64(v) : v;

// ── fn registry — keys match the LockedLambdaCel keys in the JSON catalog ──

export const commonSchemaFns: ReadonlyMap<Key, Fn> = new Map<Key, Fn>([
  ["string_isChanged",      string_isChanged],
  ["string_hydrate",        string_hydrate],
  ["string_dehydrate",      string_dehydrate],

  ["number_isChanged",      number_isChanged],
  ["number_hydrate",        number_hydrate],
  ["number_dehydrate",      number_dehydrate],

  ["boolean_isChanged",     boolean_isChanged],
  ["boolean_hydrate",       boolean_hydrate],
  ["boolean_dehydrate",     boolean_dehydrate],

  ["bigint_isChanged",      bigint_isChanged],
  ["bigint_hydrate",        bigint_hydrate],
  ["bigint_dehydrate",      bigint_dehydrate],

  ["null_isChanged",        null_isChanged],
  ["null_hydrate",          null_hydrate],
  ["null_dehydrate",        null_dehydrate],

  ["array_isChanged",       array_isChanged],
  ["array_hydrate",         array_hydrate],
  ["array_dehydrate",       array_dehydrate],

  ["object_isChanged",      object_isChanged],
  ["object_hydrate",        object_hydrate],
  ["object_dehydrate",      object_dehydrate],

  ["date_isChanged",        date_isChanged],
  ["date_hydrate",          date_hydrate],
  ["date_dehydrate",        date_dehydrate],

  ["map_isChanged",         map_isChanged],
  ["map_hydrate",           map_hydrate],
  ["map_dehydrate",         map_dehydrate],

  ["set_isChanged",         set_isChanged],
  ["set_hydrate",           set_hydrate],
  ["set_dehydrate",         set_dehydrate],

  ["regexp_isChanged",      regexp_isChanged],
  ["regexp_hydrate",        regexp_hydrate],
  ["regexp_dehydrate",      regexp_dehydrate],

  ["uint8array_isChanged",  uint8array_isChanged],
  ["uint8array_hydrate",    uint8array_hydrate],
  ["uint8array_dehydrate",  uint8array_dehydrate],
]);

// ── code-seed surface — `name` + `cels: Cel[]` (lambda cels carry _fn) ─────

export const name = (schemaSegment as unknown as 甲骨).name;

export const cels: Cel[] = ((schemaSegment as unknown as 甲骨).cels).map(
  (dc: DehydratedCel) => {
    const cel = inflateCel(dc);
    if (cel.celType === "LockedLambdaCel" || cel.celType === "EditableLambdaCel") {
      const fn = commonSchemaFns.get(cel.metadata.key);
      if (fn) cel._fn = fn;
    }
    return cel;
  },
);
