import type { Key } from "../../../../plastron/src/common.js";
import type {
  Cel, WavedCascade, DehydratedCel, FnRegistry, HydrateOptions, State,
  SegmentBundle, SegmentManifest, FingerprintComponents, HookSubscription,
} from "../../../../plastron/src/state/index.js";
import type { LambdaMetadata, LambdaKindHandler } from "../../../../plastron/src/lambdas/types/lambda.js";
import type { TagProtocol } from "../../../../plastron/src/state/types/tags.js";

// ========================================================================
// 龜卜藏 — the plastromancy-themed face of State.
//
// A skin over plastron core that renames the runtime in the vocabulary
// of Shang-era divination. Pure aesthetic + ergonomic: every method
// delegates to the underlying State.
//
// Glyph dictionary:
//   骨    — bones; the cels Map.
//   焚    — burn; flush a segment from the archive.
//   增    — augment; incremental hydrate (cels + lambdas + fns).
//   增卷  — augment with a scroll; bundle-shaped hydrate.
//   辛    — inscribing knife; the cycle-runner.
//   貞    — augur's hands; the read + write surface.
//   觀    — to observe; register a hook subscriber.
//   印鑑  — seal-impression; the runtime fingerprint.
//
// Type aliases:
//   卷    — bundle (SegmentBundle).
//   印    — manifest (SegmentManifest).
//   體    — kind handler (LambdaKindHandler).
//   紋    — tag protocol (TagProtocol).
// ========================================================================

/** 卜 — "crack". The propagating cascade of changes through the shell. */
export type 卜 = WavedCascade;

/** 卷 — a scroll. A SegmentBundle: bound, signable, transmissible. */
export type 卷 = SegmentBundle;

/** 印 — a seal. A SegmentManifest: vermillion seal stamped onto a 卷. */
export type 印 = SegmentManifest;

/** 體 — script style. A LambdaKindHandler: which scribe carves which kind of inscription. */
export type 體 = LambdaKindHandler;

/** 紋 — pattern / grain. A TagProtocol: the equality and lifecycle rules for an opaque cel value. */
export type 紋<V = unknown> = TagProtocol<V>;

export interface 龜卜藏 {
  /** 骨 — the bones. Map<Key, Cel>. */
  骨: Map<Key, Cel>;

  /** 焚 — burn an entire segment from the archive. */
  焚: (segmentKey: Key) => void;

  /** 增 — augment the archive with more plastrons + chisels. */
  增: (
    cels: Record<Key, DehydratedCel>[],
    lambdas?: Record<Key, LambdaMetadata>[],
    fnRegistry?: FnRegistry,
    options?: HydrateOptions,
  ) => Promise<龜卜藏>;

  /** 增卷 — augment with one or more scrolls (bundles). When a scroll
   *  carries a 印 (manifest) the verifier in options.verifySegment is
   *  consulted before loading. */
  增卷: (
    bundles: 卷[],
    fnRegistry?: FnRegistry,
    options?: HydrateOptions,
  ) => Promise<龜卜藏>;

  /** 觀 — register an observer (hook subscription). The observer
   *  watches; it does not act on the bones. Errors are caught and
   *  logged; observers fire-and-forget. */
  觀: (subscription: HookSubscription) => void;

  /** 印鑑 — the seal-impression. Deterministic identifier of the
   *  runtime composition (engine + 體 + 觀 + segments + 紋 + trust
   *  policy). Two runtimes with the same 印鑑 behave identically modulo
   *  runtime data. */
  印鑑: () => Promise<string>;

  /** 印鑑.分解 — the components that fold into 印鑑. Useful for devtools,
   *  audit logs, and "why did the seal change?" diagnostics. */
  印鑑分解: () => FingerprintComponents;

  /** 辛 — the inscribing knife. Runs one cycle against the given 卜 (crack). */
  辛?: (cascade: 卜) => Promise<void>;

  /** 貞 — the charging + inspection surface. */
  貞?: 貞;

  /** Escape hatch — the underlying State. Exposed so power users can
   *  reach into the engine when the facade is too narrow. */
  __state: State;
}

// ========================================================================
// 貞 — read + write surface.
//
//   察    — inspect a bone's omen (read cel.v).
//   刻    — carve one inscription (set).
//   連刻  — carve many in one ritual (batch).
//   重    — recharge a cold crack (touch).
//   施    — perform the buffered rites (consume).
//   卜    — the crack itself: the pending cascade (buffer).
// ========================================================================

export interface 貞 {
  /** 察 — inspect the omen carved on a given bone (read cel.v). */
  察(key: Key): unknown;

  /** 刻 — carve a value onto a bone (set). */
  刻(key: Key, value: unknown): Promise<void>;

  /** 連刻 — carve many inscriptions in one ritual, one cycle (batch). */
  連刻(writes: Array<[Key, unknown]>): Promise<void>;

  /** 重 — recharge the oracle for a single key (touch). */
  重(key: Key): Promise<void>;

  /** 施 — perform any buffered rites now (consume). */
  施(): Promise<void>;

  /** 卜 — the crack: the pending cascade awaiting 施 (the buffer). */
  卜: 卜;
}
