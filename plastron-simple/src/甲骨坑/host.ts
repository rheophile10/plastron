import type { 甲骨, Cel, ComputeCel, Fn, Key, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./host.json" with { type: "json" };

// ============================================================================
// host — capability surface for wasm-backed kinds.
//
// Lambdas in any kind segment (wat, py, javy, …) need access to a small
// set of host-provided fns: console.log/warn/error for diagnostics, now
// for timestamps, random for entropy, fetch for network (deferred until
// the async-call worker model in Phase 3 — sync fetch isn't viable
// without SharedArrayBuffer).
//
// The host segment owns these as locked function cels. Each kind segment
// reads the cells at compile time and binds them in its native idiom:
//
//   • wat: WebAssembly.instantiate(bytes, { host: { log, warn, … } }).
//     User WAT declares (import "host" "log" (func $log ...)).
//   • py:  pyodide.globals.set("host", { log, warn, … }) once at boot;
//     user Python calls host.log(...) directly.
//   • javy (future): registered as JS-callable fns inside QuickJS, so
//     `host.log(...)` works inside compiled JS lambdas.
//
// Security gating is segment-shaped: an app that wants lambdas not to
// log replaces the cel's _fn with a noop after install. An app running
// untrusted code installs a tighter host segment with stricter
// implementations. Per-cel gating isn't a thing — capability flows from
// what the installed host exposes.
//
// Determinism story: tests / replay can substitute host.now and
// host.random with fixed-counter / seeded implementations to make
// lambda output reproducible, without monkey-patching Date.now or
// Math.random globally.
// ============================================================================

// Console-shape we expect on globalThis. tsconfig.json doesn't ship
// DOM/Node lib types, so we narrow structurally — present in both
// browsers and Node (and absent in restricted runtimes, in which case
// the proxies become noops).
interface ConsoleShape {
  log?:   (...args: unknown[]) => void;
  warn?:  (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}
const _console = (globalThis as { console?: ConsoleShape }).console;

const log:   Fn = (...args: unknown[]) => { _console?.log?.(...args); };
const warn:  Fn = (...args: unknown[]) => { _console?.warn?.(...args); };
const error: Fn = (...args: unknown[]) => { _console?.error?.(...args); };
const now:   Fn = () => Date.now();
const random: Fn = () => Math.random();

/** Read host.{log, warn, error, now, random} from state.cels and return
 *  them as a plain object suitable for use as a WebAssembly imports
 *  member or a Pyodide globals binding. Each kind segment's compiler
 *  layer calls this at compile time. Missing cels fall back to noops /
 *  defaults so a stripped-down host segment doesn't crash compilers
 *  that expect the full surface. */
export const readHostImports = (state: State): Record<Key, Fn> => {
  const fn = (k: Key, fallback: Fn): Fn => {
    const cel = state.cels.get(k) as (ComputeCel | undefined);
    return cel?._fn ?? fallback;
  };
  return {
    log:    fn("host.log",    log),
    warn:   fn("host.warn",   warn),
    error:  fn("host.error",  error),
    now:    fn("host.now",    now),
    random: fn("host.random", random),
  };
};

export const name = "host" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["host.log",    log],
  ["host.warn",   warn],
  ["host.error",  error],
  ["host.now",    now],
  ["host.random", random],
]));
