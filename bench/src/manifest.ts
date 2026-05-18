// ============================================================================
// manifest.ts — registry of bench families.
//
// Adding a new bench family:
//   1. Write benches/<name>.plastron.ts and benches/<name>.react.ts.
//      Each script must end by emitting one __BENCH_JSON__<json> line
//      via profile.emit(report).
//   2. Append an entry below.
//   3. `npm run bench:run` will pick it up automatically.
//
// A "family" pairs a plastron variant with a React variant so the
// runner can print side-by-side stats. Either side can be omitted
// (leave the path undefined) — useful for in-progress benches.
// ============================================================================

export interface BenchVariant {
  /** Path relative to bench/src/. Must be a .ts file runnable under tsx. */
  script: string;
  /** Free-form label for output. */
  label: string;
}

export interface BenchFamily {
  /** Short name used by --filter and shown in output. */
  name: string;
  /** Human description for the README/output. */
  description: string;
  /** Optional per-family CLI args appended to every variant. */
  args?: string[];
  /** Per-cel plastron: one cel per node, formulas link them. Probes
   *  cascade-machinery overhead; not idiomatic plastron usage. */
  plastron?: BenchVariant;
  /** Naive per-cell React: one useState + useEffect per cel. */
  react?: BenchVariant;
  /** Idiomatic React: single component + useMemo / lifted state. */
  reactMemo?: BenchVariant;
  /** Idiomatic plastron: cels at I/O boundaries only, work inside a
   *  native fn cel. The "plastron used correctly" baseline. */
  plastronOneCel?: BenchVariant;
}

export const MANIFEST: BenchFamily[] = [
  {
    name: "amortization",
    description:
      "Deep-chain financial sheet — N-month amortization driven by rate/principal/term inputs. " +
      "Stresses cascade propagation along a long dependency chain plus fan-in aggregates.",
    plastron:       { script: "benches/amortization.plastron.ts",         label: "plastron" },
    react:          { script: "benches/amortization.react.ts",            label: "react" },
    reactMemo:      { script: "benches/amortization.react-memo.ts",       label: "react-memo" },
    plastronOneCel: { script: "benches/amortization.plastron-onecel.ts",  label: "plastron-onecel" },
  },
  {
    name: "life",
    description:
      "Conway's Life on an N×N grid — each next-gen cell depends on 8 neighbors. " +
      "Uniform fan-in-8 throughput test; reports generations/sec.",
    plastron:       { script: "benches/life.plastron.ts",         label: "plastron" },
    react:          { script: "benches/life.react.ts",            label: "react" },
    reactMemo:      { script: "benches/life.react-memo.ts",       label: "react-memo" },
    plastronOneCel: { script: "benches/life.plastron-onecel.ts",  label: "plastron-onecel" },
  },
  {
    name: "cellx",
    description:
      "Synthetic layered graph — 1000 leaves, 5 layers, each cell depends on 4 from prior layer. " +
      "Canonical signal-lib microbenchmark (cellx, S.js, Solid, etc.).",
    plastron:       { script: "benches/cellx.plastron.ts",         label: "plastron" },
    react:          { script: "benches/cellx.react.ts",            label: "react" },
    reactMemo:      { script: "benches/cellx.react-memo.ts",       label: "react-memo" },
    plastronOneCel: { script: "benches/cellx.plastron-onecel.ts",  label: "plastron-onecel" },
  },
];
