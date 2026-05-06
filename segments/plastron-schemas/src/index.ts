import type {
  LambdaKindHandler, KindContext, CompiledLambda,
  RecalculationConfig,
} from "../../../plastron/src/index.js";
import type { Fn } from "../../../plastron/src/lambdas/types/lambda.js";
import type { SchemaRecords } from "../../../plastron/src/schemas/types/schema.js";

// ========================================================================
// withSchemaValidation — kind-handler middleware that enforces zod
// schemas on lambda inputs and outputs.
//
// Plastron core no longer validates inline. To get the previous strict-
// mode behaviour, wrap your kind handler:
//
//   const rt = await runtime(cels, lambdas, fns, {
//     kinds: {
//       native: withSchemaValidation(nativeKind),
//       python: withSchemaValidation(pythonKind),
//     },
//   });
//
// At hydrate, the wrapper inspects the lambda metadata. If neither
// inputSchema nor outputSchema is declared, it returns the inner
// CompiledLambda unchanged — zero overhead for unschemed lambdas.
//
// At invoke, the wrapper consults config_recalculation.strictTypes.
// When strict, inputs and outputs are validated against the schema
// records stored in config_schemas. Validation failures throw, which
// runCycle catches and surfaces via the errors default segment.
// ========================================================================

export const withSchemaValidation = (inner: LambdaKindHandler): LambdaKindHandler => ({
  key: inner.key,
  prepare(ctx: KindContext): CompiledLambda {
    const compiled = inner.prepare(ctx);
    if (!compiled.fn) return compiled;

    const meta = ctx.meta;
    if (!meta?.inputSchema && !meta?.outputSchema) {
      // No schemas declared on this lambda — pass-through.
      return compiled;
    }

    const cels = ctx.cels;
    const lambdaKey = ctx.cel.l;
    const inner_fn = compiled.fn;

    const validatingFn: Fn = async (inputs) => {
      const recalcCfg = (cels.get("config_recalculation")?.v ?? {}) as RecalculationConfig;
      // strictTypes is the gate. When false, we're a no-op pass-through.
      if (recalcCfg.strictTypes !== true) {
        return inner_fn(inputs);
      }

      const schemas = (cels.get("config_schemas")?.v ?? {}) as SchemaRecords;

      if (meta.inputSchema) {
        const inSchema = schemas[meta.inputSchema];
        if (inSchema) {
          const parsed = inSchema.zod.safeParse(inputs);
          if (!parsed.success) {
            throw new Error(
              `Input for lambda "${lambdaKey}" fails schema "${meta.inputSchema}": ${parsed.error.message}`
            );
          }
        }
      }

      const result = await Promise.resolve(inner_fn(inputs));

      if (meta.outputSchema) {
        const outSchema = schemas[meta.outputSchema];
        if (outSchema) {
          const parsed = outSchema.zod.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `Output of lambda "${lambdaKey}" fails schema "${meta.outputSchema}": ${parsed.error.message}`
            );
          }
        }
      }

      return result;
    };

    return { fn: validatingFn, dispose: compiled.dispose };
  },
});
