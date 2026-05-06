import type { Key } from "../../common.js";
import type { WavedCascade } from "./types.js";

// ========================================================================
// Cycle hook surface — observation-only callbacks segments use to react
// to cycle activity. Hooks observe; they do not replace cycle behaviour.
// Payloads are plain data, not live cel references, so subscribers can
// ship them across worker boundaries if needed.
//
// Hook errors are logged and swallowed; a misbehaving subscriber never
// crashes the cycle. Async hooks fire-and-forget — the cycle does not
// await returned promises (rejected promises are caught and logged).
//
// Zero-cost when nothing subscribes: each fireHook call early-returns
// on an empty subscriber list.
// ========================================================================

export interface BeforeCycleEvent {
  cascade: WavedCascade;
}

export interface AfterLambdaInvokeEvent {
  key: Key;
  inputs: Record<string, unknown>;
  output?: unknown;
  durationMs: number;
  /** Present when the lambda threw or rejected; output is undefined. */
  error?: unknown;
}

export interface AfterWaveEvent {
  waveIndex: number;
  changedKeys: Key[];
}

export interface AfterCycleEvent {
  allChanges: Key[];
}

export interface AfterHydrateEvent {
  /** Reserved for the runtime fingerprint, populated when that API
   *  lands. Empty in this phase. */
  fingerprint?: string;
}

/** A subscription is an object whose keys are hook names. Optional id
 *  for diagnostics. Subscribers register one of these per call. */
export interface HookSubscription {
  id?: string;
  beforeCycle?: (event: BeforeCycleEvent) => void | Promise<void>;
  afterLambdaInvoke?: (event: AfterLambdaInvokeEvent) => void | Promise<void>;
  afterWave?: (event: AfterWaveEvent) => void | Promise<void>;
  afterCycle?: (event: AfterCycleEvent) => void | Promise<void>;
  afterHydrate?: (event: AfterHydrateEvent) => void | Promise<void>;
}

export type HookName = Exclude<keyof HookSubscription, "id">;

/** Fire a hook against all subscribers. Errors are caught and logged.
 *  Returned promises are observed only to attach a .catch handler that
 *  prevents unhandled rejections; the cycle does not await them. */
export const fireHook = <K extends HookName>(
  subs: ReadonlyArray<HookSubscription> | undefined,
  name: K,
  event: Parameters<NonNullable<HookSubscription[K]>>[0],
): void => {
  if (!subs || subs.length === 0) return;
  for (const sub of subs) {
    const handler = sub[name];
    if (!handler) continue;
    try {
      const result = (handler as (e: typeof event) => void | Promise<void>)(event);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[plastron hook] async error in ${name}${sub.id ? ` (${sub.id})` : ""}:`, err);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plastron hook] error in ${name}${sub.id ? ` (${sub.id})` : ""}:`, err);
    }
  }
};
