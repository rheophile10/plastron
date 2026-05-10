// ============================================================================
// perf-env — capture a one-shot snapshot of the runtime's capabilities.
//
// Surfaced as the value of stats_environment.v. Hosts read this once
// after hydrate to decide which optional optimization paths are
// available (worker SAB fast-path, WebGPU compute, WASM SIMD, etc.).
// Re-runnable on demand via the refreshEnvironmentStats core-fn.
//
// Almost every probe is sync feature detection. The single async hop
// (`navigator.gpu.requestAdapter()`) populates `webGPUAdapter`; while
// it's resolving the field is `undefined`. captureEnvironment never
// throws — it returns falsy on any per-feature failure.
// ============================================================================

export interface EnvironmentSnapshot {
  /** Snapshot timestamp (ms since epoch). */
  capturedAt: number;

  /** Worker availability. */
  webWorkers:    boolean;
  nodeWorkers:   boolean;
  workerCount:   number;

  /** Cross-origin isolation — gate for SharedArrayBuffer. */
  crossOriginIsolated: boolean;
  sharedArrayBuffer:   boolean;
  atomics:             boolean;

  /** WASM features. */
  wasm:        boolean;
  wasmSIMD:    boolean;
  wasmThreads: boolean;

  /** GPU / compute. */
  webGPU:        boolean;
  /** Resolved adapter probe. `undefined` while still awaiting; `true`
   *  when navigator.gpu.requestAdapter() resolved non-null; `false`
   *  when the API exists but failed to produce an adapter. */
  webGPUAdapter: boolean | undefined;

  /** Performance API. */
  highResTiming: boolean;

  /** Memory introspection. */
  memoryAPI:     boolean;
}

// ── Sync feature probes ─────────────────────────────────────────────────────

const safe = <T>(fn: () => T, fallback: T): T => {
  try { return fn(); } catch { return fallback; }
};

const detectWebWorkers = (): boolean =>
  safe(() => typeof (globalThis as { Worker?: unknown }).Worker !== "undefined", false);

const detectNodeWorkers = (): boolean => safe(() => {
  // node:worker_threads is only importable in Node. We probe via the
  // process global — on browsers `process` is undefined.
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === "string";
}, false);

const detectWorkerCount = (): number => safe(() => {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (typeof nav?.hardwareConcurrency === "number") return nav.hardwareConcurrency;
  // Node fallback — `os.availableParallelism` is best-effort. We avoid
  // a dynamic import and look for the lazily-pinned process.
  const proc = (globalThis as { process?: unknown }).process;
  if (proc) {
    // Best-effort: 1 if everything else fails. Hosts that care set
    // their pool size from other signals.
    return 1;
  }
  return 1;
}, 1);

const detectCrossOriginIsolated = (): boolean =>
  safe(() => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true, false);

const detectSAB = (): boolean =>
  safe(() => typeof (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer !== "undefined", false);

const detectAtomics = (): boolean =>
  safe(() => typeof (globalThis as { Atomics?: unknown }).Atomics !== "undefined", false);

const detectWasm = (): boolean =>
  safe(() => typeof (globalThis as { WebAssembly?: unknown }).WebAssembly !== "undefined", false);

// SIMD: try to validate a tiny SIMD-tagged module. The compile fails
// when the host's V8 is missing the SIMD opcodes.
const detectWasmSIMD = (): boolean => safe(() => {
  const wa = (globalThis as { WebAssembly?: { validate?: (b: Uint8Array) => boolean } }).WebAssembly;
  if (!wa?.validate) return false;
  // Minimal module with v128.const — the smallest SIMD opcode probe.
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x0a, 0x01, 0x08, 0x00,
    0xfd, 0x0c,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x0b,
  ]);
  return wa.validate(bytes);
}, false);

const detectWasmThreads = (): boolean => detectSAB() && detectAtomics() && detectWasm();

const detectWebGPU = (): boolean =>
  safe(() => typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu !== "undefined", false);

const detectHighResTiming = (): boolean =>
  safe(() => typeof (globalThis as { performance?: { now?: () => number } }).performance?.now === "function", false);

const detectMemoryAPI = (): boolean => safe(() => {
  const perf = (globalThis as { performance?: { measureUserAgentSpecificMemory?: unknown } }).performance;
  return typeof perf?.measureUserAgentSpecificMemory === "function";
}, false);

// ── Async GPU adapter probe ─────────────────────────────────────────────────

const probeWebGPUAdapter = async (): Promise<boolean> => {
  try {
    const gpu = (globalThis as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } })
      .navigator?.gpu;
    if (!gpu?.requestAdapter) return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
};

// ── Public entry — assembles the snapshot ───────────────────────────────────

export const captureEnvironment = async (): Promise<EnvironmentSnapshot> => {
  const webGPU = detectWebGPU();
  const snap: EnvironmentSnapshot = {
    capturedAt: Date.now(),
    webWorkers:          detectWebWorkers(),
    nodeWorkers:         detectNodeWorkers(),
    workerCount:         detectWorkerCount(),
    crossOriginIsolated: detectCrossOriginIsolated(),
    sharedArrayBuffer:   detectSAB(),
    atomics:             detectAtomics(),
    wasm:                detectWasm(),
    wasmSIMD:            detectWasmSIMD(),
    wasmThreads:         detectWasmThreads(),
    webGPU,
    webGPUAdapter:       webGPU ? await probeWebGPUAdapter() : false,
    highResTiming:       detectHighResTiming(),
    memoryAPI:           detectMemoryAPI(),
  };
  return snap;
};

/** Sync-only portion of the environment snapshot. Used at hydrate to
 *  populate stats_environment with the cheap probes immediately; the
 *  async webGPU adapter probe runs in the background and updates the
 *  cel when it resolves. */
export const captureEnvironmentSync = (): EnvironmentSnapshot => {
  const webGPU = detectWebGPU();
  return {
    capturedAt: Date.now(),
    webWorkers:          detectWebWorkers(),
    nodeWorkers:         detectNodeWorkers(),
    workerCount:         detectWorkerCount(),
    crossOriginIsolated: detectCrossOriginIsolated(),
    sharedArrayBuffer:   detectSAB(),
    atomics:             detectAtomics(),
    wasm:                detectWasm(),
    wasmSIMD:            detectWasmSIMD(),
    wasmThreads:         detectWasmThreads(),
    webGPU,
    // undefined while the async probe is in flight; the kernel updates
    // this in place once probeWebGPUAdapter resolves.
    webGPUAdapter:       webGPU ? undefined : false,
    highResTiming:       detectHighResTiming(),
    memoryAPI:           detectMemoryAPI(),
  };
};

/** Resolve and overwrite `webGPUAdapter` on the snapshot. Used by the
 *  hydrate-time background probe to upgrade the partial sync snapshot
 *  into a full one. */
export const resolveWebGPUAdapter = async (snap: EnvironmentSnapshot): Promise<void> => {
  if (!snap.webGPU) {
    snap.webGPUAdapter = false;
    return;
  }
  snap.webGPUAdapter = await probeWebGPUAdapter();
};
