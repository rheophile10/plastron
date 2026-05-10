import {
  useCallback, useEffect, useRef, useState,
  type Dispatch, type SetStateAction,
} from "react";
import type { Fn, State } from "../../../plastron/src/index.js";

// ========================================================================
// useReactSource(state, fnKey, initial?) — expose a React state value
// to plastron lambdas as a callable Fn.
//
// Registers a function under `state.fns.get(fnKey)` that, when called,
// returns the current React state value. Plastron lambdas can pull the
// React-owned value into the cascade by referencing the fn directly:
//
//     state.fns.get("ui:selectedRow")?.()
//
// or, more idiomatically, by binding it as a side input via a wrapper
// lambda. The fn body is just `() => latestValueRef.current` — it's
// not itself a cel and doesn't trigger a cascade by itself. To make
// plastron see updates, the host must `set(state, key, ...)` after
// updating the React value, OR the React update path can route through
// `set` directly (see channel-binding alternative below).
//
// Returns React's familiar [value, setValue] tuple. Calling setValue
// updates the React state (re-renders consumers) AND the fn's
// underlying ref so the next `state.fns.get(fnKey)()` returns the new
// value synchronously — useful when a plastron lambda fires in the
// same tick as setValue, before React has flushed the re-render.
//
// ── Design choice: fn-registration vs channel-binding ──
//
// Two ways to push React → plastron:
//
//   (A) fn-registration (this hook).
//       Pros: pull-only API, no cel pre-allocation, plastron lambdas
//             read the latest value on demand. Lets a lambda say "give
//             me whatever React is showing right now" without the host
//             pre-declaring a cel for it.
//       Cons: doesn't fire a cascade. The host must call `set` on a
//             companion cel (or `touch` a dynamic cel) to trigger
//             downstream recomputes.
//
//   (B) channel-binding (alternative; not implemented).
//       The hook would call `state.fns.get("set")(state, "myCel", value)`
//       on every setValue, pushing the value into a pre-existing cel
//       and firing the cascade. Simpler downstream but requires the
//       host to allocate a cel up front, and re-renders block on the
//       async `set` resolution.
//
// We picked (A) because it composes better with plastron's existing
// `set` core fn — anyone wanting (B) writes one line in their setValue
// handler:
//
//     const [value, setValue] = useReactSource(state, "ui:row");
//     const setBoth = useCallback(async (v: number) => {
//       setValue(v);
//       await (state.fns.get("set") as Fn)(state, "ui:row:cel", v);
//     }, [state, setValue]);
//
// Lifecycle:
//   • mount:    install fn at state.fns[fnKey]. Throws via console.error
//               if the slot is already taken (no overwrite — protect
//               against accidental double-register).
//   • update:   setValue updates the ref synchronously and React state
//               asynchronously. The registered fn always sees the latest
//               via the ref, even before the re-render flushes.
//   • unmount:  delete state.fns[fnKey] (if we still own it) and remove
//               state.fnMetadata[fnKey].
//
// Strict-mode safety: the unregister-on-cleanup path checks identity
// (state.fns.get(fnKey) === ourFn) before deleting, so a re-mount that
// re-registered before our cleanup ran doesn't get clobbered.
// ========================================================================

export const useReactSource = <T,>(
  state: State,
  fnKey: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(initial);

  // Ref tracks the latest value so the registered fn returns it
  // synchronously — even if a plastron lambda fires in the same tick
  // as setValue and React hasn't re-rendered yet.
  const latestRef = useRef<T>(value);
  latestRef.current = value;

  // The fn body — captured once, reads from the ref every call. We
  // intentionally hold the same identity across re-renders so cascade
  // closures that captured `state.fns.get(fnKey)` at compile time
  // don't get stale.
  const fnRef = useRef<Fn | null>(null);
  if (fnRef.current === null) {
    fnRef.current = (() => latestRef.current) as Fn;
  }

  useEffect(() => {
    const fn = fnRef.current;
    if (!fn) return;

    const existing = state.fns.get(fnKey);
    if (existing && existing !== fn) {
      // Don't overwrite an existing fn we don't own — would clobber
      // a kernel core fn or another segment's lambda.
      // eslint-disable-next-line no-console
      console.error(
        `[plastron-react-host] useReactSource: fnKey "${fnKey}" is ` +
        `already registered. Pick a unique key.`,
      );
      return;
    }

    state.fns.set(fnKey, fn);
    state.fnMetadata.set(fnKey, {
      key: fnKey,
      kind: "react-source",
    });

    return () => {
      // Only delete if we still own the slot — guards against a
      // re-render that registered a fresh fn under the same key.
      if (state.fns.get(fnKey) === fn) {
        state.fns.delete(fnKey);
        state.fnMetadata.delete(fnKey);
      }
    };
  }, [state, fnKey]);

  // Wrap setValue so we can also bump the ref synchronously. The
  // returned setter has React's normal Dispatch<SetStateAction<T>>
  // shape — supports both direct values and updater functions.
  const setBoth = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((prev) => {
      const resolved =
        typeof next === "function"
          ? (next as (p: T) => T)(prev)
          : next;
      latestRef.current = resolved;
      return resolved;
    });
  }, []);

  return [value, setBoth];
};
