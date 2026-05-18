// ============================================================================
// params.ts — single source of truth for bench parameters.
//
// Both .plastron.ts and .react.ts variants import their family's entry
// from here so sizes/iterations/workload constants stay in lockstep.
//
// Shape:
//   shared    — values used by both variants (workload constants).
//   plastron  — variant-specific knobs (sizes, iteration counts).
//   react     — same. Often smaller N because React's per-cell hook
//               cascade has worse complexity than plastron's.
//
// Iteration counts are functions of N so we can taper at large sizes
// without lookup tables.
//
// Override at runtime by setting BENCH_PARAMS_OVERRIDE_<FAMILY> to a
// JSON object that's shallow-merged into the family's variant block.
// Example:
//   BENCH_PARAMS_OVERRIDE_AMORTIZATION='{"react":{"sizes":[10,20]}}'
// Useful for "just run a tiny smoke pass" without editing this file.
// ============================================================================

export interface VariantParams {
  sizes: readonly number[];
  iterations: (n: number) => number;
  warmup: (n: number) => number;
}

export interface AmortizationParams {
  shared: {
    principal: number;
    payment: number;
    monthlyRateInit: number;
  };
  plastron: VariantParams;
  react: VariantParams;
  reactMemo: VariantParams;
  plastronOneCel: VariantParams;
}

export interface LifeParams {
  shared: {
    /** Probability each cell starts alive at seed time. */
    initialDensity: number;
    /** RNG seed for reproducible initial grids. */
    seed: number;
  };
  plastron:       VariantParams & { ticksPerIteration: number };
  react:          VariantParams & { ticksPerIteration: number };
  reactMemo:      VariantParams & { ticksPerIteration: number };
  plastronOneCel: VariantParams & { ticksPerIteration: number };
}

export interface CellxParams {
  shared: {
    layers: number;
    /** Inputs per non-leaf cell. */
    fanIn: number;
    /** RNG seed for reproducible wiring. */
    seed: number;
  };
  plastron:       VariantParams;
  react:          VariantParams;
  reactMemo:      VariantParams;
  plastronOneCel: VariantParams;
}

const amortization: AmortizationParams = {
  shared: {
    principal: 300_000,
    payment: 1610,
    monthlyRateInit: 0.05 / 12,
  },
  plastron: {
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 20,
  },
  react: {
    // React's per-cell cascade is O(N²) under nested components; cap
    // at 250 to keep total wall-time under a minute.
    sizes: [50, 100, 250],
    iterations: (n) => (n >= 250 ? 30 : n >= 100 ? 80 : 200),
    warmup: () => 5,
  },
  reactMemo: {
    // Idiomatic React: single component + useMemo. No per-cell hooks,
    // so we can scale to plastron's sizes for a fair like-for-like.
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 10,
  },
  plastronOneCel: {
    // "Plastron used correctly": cels only at the I/O boundary (one
    // input cel + one fn cel + one formula cel), workload done inside
    // a native fn. Same sizes as reactMemo for direct comparison.
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 10,
  },
};

const life: LifeParams = {
  shared: {
    initialDensity: 0.30,
    seed: 0xC0FFEE,
  },
  plastron: {
    sizes: [20, 50, 100],   // N×N grids → 400, 2500, 10000 cells
    iterations: (n) => (n >= 100 ? 20 : n >= 50 ? 50 : 200),
    warmup: () => 5,
    ticksPerIteration: 1,
  },
  react: {
    sizes: [20, 50, 100],
    iterations: (n) => (n >= 100 ? 10 : n >= 50 ? 30 : 100),
    warmup: () => 3,
    ticksPerIteration: 1,
  },
  reactMemo: {
    // Single component + useEffect/useMemo, no per-cell overhead.
    sizes: [20, 50, 100],
    iterations: (n) => (n >= 100 ? 50 : n >= 50 ? 100 : 200),
    warmup: () => 5,
    ticksPerIteration: 1,
  },
  plastronOneCel: {
    sizes: [20, 50, 100],
    iterations: (n) => (n >= 100 ? 50 : n >= 50 ? 100 : 200),
    warmup: () => 5,
    ticksPerIteration: 1,
  },
};

const cellx: CellxParams = {
  shared: {
    layers: 5,
    fanIn: 4,
    seed: 0xDA7A,
  },
  plastron: {
    // "size" here is the width of each layer. Standard cellx config is 1000.
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 20,
  },
  react: {
    sizes: [50, 100, 250],
    iterations: (n) => (n >= 250 ? 30 : n >= 100 ? 80 : 200),
    warmup: () => 5,
  },
  reactMemo: {
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 10,
  },
  plastronOneCel: {
    sizes: [100, 500, 1000],
    iterations: () => 200,
    warmup: () => 10,
  },
};

// ── Override plumbing ───────────────────────────────────────────────────────

// Coerce iteration/warmup overrides: JSON can't carry functions, so a
// scalar number in the patch becomes `() => num`. Lets users write
// `{"react":{"iterations":50}}` from the env without ceremony.
const coerceVariant = (base: VariantParams, patch: Record<string, unknown> | undefined): VariantParams => {
  if (!patch) return base;
  const out = { ...base, ...patch } as VariantParams;
  if (typeof patch.iterations === "number") out.iterations = () => patch.iterations as number;
  if (typeof patch.warmup === "number")     out.warmup     = () => patch.warmup     as number;
  return out;
};

const applyOverride = <T extends {
  plastron: VariantParams;
  react: VariantParams;
  reactMemo: VariantParams;
  plastronOneCel: VariantParams;
  shared: unknown;
}>(
  family: string,
  base: T,
): T => {
  const raw = process.env[`BENCH_PARAMS_OVERRIDE_${family.toUpperCase()}`];
  if (!raw) return base;
  try {
    const patch = JSON.parse(raw) as Record<string, unknown>;
    // JSON keys accept either camelCase or kebab-case.
    const memoPatch    = (patch.reactMemo      ?? patch["react-memo"])       as Record<string, unknown> | undefined;
    const oneCelPatch  = (patch.plastronOneCel ?? patch["plastron-onecel"])  as Record<string, unknown> | undefined;
    return {
      ...base,
      ...patch,
      shared:         { ...(base.shared as object), ...(patch.shared as object | undefined ?? {}) },
      plastron:       coerceVariant(base.plastron,       patch.plastron as Record<string, unknown> | undefined),
      react:          coerceVariant(base.react,          patch.react    as Record<string, unknown> | undefined),
      reactMemo:      coerceVariant(base.reactMemo,      memoPatch),
      plastronOneCel: coerceVariant(base.plastronOneCel, oneCelPatch),
    };
  } catch (err) {
    console.error(`Bad BENCH_PARAMS_OVERRIDE_${family.toUpperCase()}: ${(err as Error).message}`);
    return base;
  }
};

export const params = {
  amortization: applyOverride("amortization", amortization),
  life:         applyOverride("life", life),
  cellx:        applyOverride("cellx", cellx),
};
