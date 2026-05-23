import type { JsonValue, Key } from "./index.js";
import type { Channel } from "./channels.js";
import type { Fn, ResolvedInputs } from "./lambdas.js";
import type { 譜 } from "./譜.js";
import type { Schema } from "./schemas.js";

import type { ValueCel } from "./value.js";
import type { ChannelCel } from "./channels.js";
import type { CompilerCel } from "./compilers.js";
import type { EditableLambdaCel, LockedLambdaCel } from "./lambdas.js";
import type { FormulaCel } from "./formulas.js";
import type { SchemaCel } from "./schemas.js";

// ── metadata ────────────────────────────────────────────────────────────────

export interface BaseCelMetadata extends 譜 {
  key: Key;
  segment: Key;
  schema?: Key;
  v?: JsonValue;
  channel?: Key[];
}

export interface ComputeCelMetadata extends BaseCelMetadata {
  inputMap?: Record<string, Key | Key[]>;
  /** Optional per-input kind declaration. When present, hydrate
   *  validates that the source cel referenced via inputMap[name] has a
   *  matching kindOf — refuses to wire a kind="wat" input from a
   *  kind="js" source without an explicit bridge in between, and so on.
   *  Absent entries (name unmentioned in inputKinds) skip validation,
   *  preserving the v1 behavior for cels that don't opt in. The kind
   *  string is a regular Key — same name space as kindOf returns. */
  inputKinds?: Record<string, Key>;
}

/** Loose union shape kept for DehydratedCel and inflate-time
 *  intermediates. Live Cels use their kind-specific metadata.
 *  `compiler` and `kind` resolve compiler dispatch — FormulaCel reads
 *  `compiler`, LambdaCel reads `kind`. */
export interface CelMetadata extends BaseCelMetadata {
  compiler?: Key;
  kind?: string;
  inputMap?: Record<string, Key | Key[]>;
  inputKinds?: Record<string, Key>;
}

// ── cel kinds ───────────────────────────────────────────────────────────────

export type CelType =
  | "ValueCel"
  | "EditableLambdaCel"
  | "LockedLambdaCel"
  | "SchemaCel"
  | "FormulaCel"
  | "CompilerCel"
  | "ChannelCel";

export interface BaseCel {
  celType: CelType;
  metadata: BaseCelMetadata;
  v: unknown;
  locked?: boolean;
  schema?: Schema;
}

/** Intermediate for fireable cels — anything with an fn body the
 *  cascade dispatches to. Lambda + Formula variants extend this. */
export interface ComputeCel extends BaseCel {
  metadata: ComputeCelMetadata;
  // Formula source (S-expression for FormulaCel, host-language source
  // for EditableLambdaCel). Absent on native LockedLambdaCels seeded
  // with `_fn` directly.
  f?: string;
  wave?: number;
  dynamic?: boolean;
  _fn?: Fn;
  _dispose?: () => void;
  _inputEntries?: Array<[string, Cel | undefined | Array<Cel | undefined>]>;
  _channelHandlers?: Channel[];
  _buildEvaluate?: (
    inputs: ResolvedInputs,
    cspEvalAvailable: boolean,
  ) => (() => unknown) | Promise<() => unknown>;
  _evaluate?: () => unknown;
  /** Wasm binary produced by the compiler when the source is a wasm
   *  language (wat today; javy/rust later). Hydrate stashes the
   *  CompiledEnvelope's `wasm` field here. Read by `wasm-to-wat` to
   *  expose the WAT text form, and by future worker dispatch to ship
   *  the module bytes once per worker instead of recompiling. */
  _wasm?: Uint8Array;
}

export interface DehydratedCel {
  key: Key;
  celType: CelType;
  metadata: CelMetadata;
  wave?: number;
  locked?: boolean;
  dynamic?: boolean;
  f?: string;
}

export type Cel =
  | ValueCel
  | EditableLambdaCel
  | LockedLambdaCel
  | FormulaCel
  | SchemaCel
  | CompilerCel
  | ChannelCel;

/** Cels whose body the cascade fires — Formula or either Lambda
 *  variant. The kernel reads `_fn`, `_evaluate`, etc. off these. */
export type FireableCel = FormulaCel | EditableLambdaCel | LockedLambdaCel;

/** True when the cel's kind has an fn body the cascade fires — i.e.
 *  Formula or either Lambda variant. Narrows the union to ComputeCel
 *  members so the kernel can read `_fn`, `_evaluate`, etc. */
export const isFireable = (c: Cel): c is FireableCel =>
  c.celType === "FormulaCel"
  || c.celType === "EditableLambdaCel"
  || c.celType === "LockedLambdaCel";

/** Execution-domain tag for a fireable cel. FormulaCels evaluate in JS
 *  by construction (the formula evaluator runs main-thread JS). Lambda
 *  cels carry their kind in `metadata.kind` — "wat", "py", "javy",
 *  "native", "js", etc. — naming the compiler segment that owns them.
 *  Used by the per-kind precompute layer to group same-kind cels in
 *  each level so a future worker-backed kind can dispatch its batch as
 *  a single round-trip. Falls back to "js" for lambdas missing a kind
 *  (registerLambda assigns "js" by default; only legacy paths may omit). */
export const kindOf = (c: FireableCel): Key => {
  if (c.celType === "FormulaCel") return "js";
  return c.metadata.kind ?? "js";
};
