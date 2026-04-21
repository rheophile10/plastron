import type { Key } from "../../../common.js";

// ========================================================================
// Recalculation mode — stored as the .v of the `config_recalculation` cel.
// ========================================================================

export type RecalculationMode =
  | "automatic"
  | "automaticExceptData"
  | "manual";

export interface RecalculationConfig {
  mode: RecalculationMode;
  intervalMs?: number;
  /** When true, runCycle validates each lambda's inputs against
   *  inputSchema and output against outputSchema. */
  strictTypes?: boolean;
  /** Key of the lambda that evaluates `cel.f` formula strings. Defaults to "f". */
  formulaParser?: string;
}

// ========================================================================
// changeIndexConfig / changeIndices — named inverse-change tracking.
// ========================================================================

export type ChangeIndexConfig = Record<string, string[]>;
export type ChangeIndices = Record<string, Key[][]>;

// ========================================================================
// errors — runtime-populated reserved cel holding unrecovered errors.
// ========================================================================

export interface ErrorInfo {
  error: string;
  code?: string;
  at: number;
  inputs?: Record<string, unknown>;
}

export type Errors = Record<Key, ErrorInfo>;
