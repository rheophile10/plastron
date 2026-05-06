# `plastron-schemas` segment

Kind-handler middleware that enforces zod schemas on lambda inputs and outputs. Restores the strict-types behaviour that used to live inline in `runCycle.ts` before plastron's eviction work.

## Usage

```ts
import { runtime, nativeKind } from "plastron";
import { withSchemaValidation } from "plastron-schemas";

const rt = await runtime(myCels, myLambdas, myFns, {
  kinds: {
    native: withSchemaValidation(nativeKind),
    // wrap whichever other kinds you want validated
  },
});

// Toggle validation on/off via the config_recalculation cel:
await rt.input.set("config_recalculation", {
  mode: "automatic",
  strictTypes: true,  // enables validation
});
```

## How it works

`withSchemaValidation(handler)` returns a new `LambdaKindHandler` whose `prepare`:

1. Calls the inner handler's `prepare` first.
2. Inspects the lambda's metadata. If neither `inputSchema` nor `outputSchema` is declared, returns the inner `CompiledLambda` unchanged — **zero overhead** for unschemed lambdas.
3. Otherwise wraps the `fn` in a validator that:
   - Reads `config_recalculation.strictTypes` per-invocation — runtime toggle.
   - When strict, validates `inputs` against the input schema before calling the inner fn.
   - Validates the output against the output schema after the inner fn returns.
   - Throws on validation failure. `runCycle` catches and surfaces via the `errors` default segment.

## Why a segment, not in core

Core stays uncoupled from any one schema library (zod). Different applications can wrap with their own validators — superstruct, runtypes, custom check functions — without touching plastron core. The wrapper pattern composes cleanly: you can stack validators, perf timers, retry logic, etc. on the same kind handler.
