import type { Key } from "../common.js";
import type {
  Cel, WavedCascade, DehydratedCel, FnRegistry, HydrateOptions,
} from "../state/index.js";
import type { LambdaMetadata } from "../lambdas/types/lambda.js";

// ========================================================================
// 龜卜藏 — the plastronomy-themed face of State.
//
//   骨 — "bones": the cels Map.
//   焚 — "burn": torch a segment.
//   增 — "augment": incremental hydrate (add more cels / lambdas).
//   卜 — "crack": the cycle-runner closure.
//   貞 — "charge": the write + read surface.
// ========================================================================

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

  /** 卜 — crack the oracle. Runs one cycle against the given cascade. */
  卜?: (cascade: WavedCascade) => Promise<void>;

  /** 貞 — the charging + inspection surface. */
  貞?: 貞;
}

// ========================================================================
// 貞 — read + write surface.
//
//   察    — inspect a bone's omen (read cel.v).
//   刻    — carve one inscription (set).
//   連刻  — carve many in one ritual (batch).
//   重    — recharge a cold crack (touch).
//   施    — perform the buffered rites (consume).
//   待    — pending charges queue (buffer).
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

  /** 待 — the queue of pending charges awaiting 施 (the buffer). */
  待: WavedCascade;
}
