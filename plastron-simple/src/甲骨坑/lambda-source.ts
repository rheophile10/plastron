import type { 甲骨, Cel, Fn } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./lambda-source.json" with { type: "json" };

// ============================================================================
// lambda-source — built-in opt-in schema for round-tripping lambda /
// formula source bodies in a readable form.
//
// A fireable cel (EditableLambdaCel, FormulaCel) carries its source on
// `cel.f`. The live form is always a single string — that's what the
// compiler consumes. But hand-authored JSON benefits from carrying
// multi-line source as a string[] of lines: diffs are clean, no
// embedded \n escapes, and the .json file actually reads like the
// source it represents.
//
// Hydrate side is universal — inflateCel always joins a string[] into
// a "\n"-separated string regardless of schema. Authors get the
// readable form to work in any cel for free.
//
// Dehydrate side is opt-in via this schema. Declare
//
//     metadata: { …, "schema": "lambda-source" }
//
// on any EditableLambdaCel or FormulaCel whose source you want to
// round-trip in array form. On dehydrate, sourceDehydrate (this
// segment's `lambda-source.split` fn) splits multi-line strings back
// into string[]. Single-line sources stay as plain strings — no need
// to wrap one-liners in a one-element array.
//
// Other schemas can ship their own sourceDehydrate (and the matching
// JSON-side input is already permissive) for richer transforms:
// minify-on-dehydrate, pretty-print-on-dehydrate, base64-wrap binary
// source, and so on.
// ============================================================================

const split: Fn = (f) =>
  typeof f === "string" && f.includes("\n") ? f.split("\n") : f;

export const name = "lambda-source" as const;

export const cels: Cel[] = bindNativeFns(
  seed as unknown as 甲骨,
  new Map<string, Fn>([
    ["lambda-source.split", split],
  ]),
);
