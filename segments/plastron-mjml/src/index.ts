/// <reference path="./mjml.d.ts" />
import type {
  Compiler, Fn, LambdaKey, SegmentManifest, State,
} from "../../../plastron/src/index.js";
// `mjml` is a CJS module whose default export is `mjml2html(input, options?)`.
// We pull the default off the `* as` namespace so the type stays narrow.
import * as mjmlPkg from "mjml";

// ============================================================================
// plastron-mjml — MJML compiler for plastron.
//
// Cels declare `cel.l = "mjml"` and ship MJML source in `cel.f`. At
// hydrate the compiler at state.fns.get("mjml") turns the source into
// a runtime fn that, when fired, substitutes the cel's resolved inputs
// into `{{varName}}` placeholders and runs mjml2html → returns the
// produced HTML string.
//
// Templating model: pre-process. The cel's resolved inputs are
// rendered as primitive strings (numbers and booleans coerced via
// String(); null/undefined → ""), HTML-escaped, and substituted for
// matching `{{name}}` tokens before mjml sees the source. This keeps
// the MJML side oblivious to plastron — it sees a finished MJML
// document — and lets the cel's inputMap drive content via the same
// mechanism every other compiler kind uses.
//
// Async note: mjml2html is async (mjml-core v5 returns a Promise).
// The runtime fn returns Promise<string>; runCascade awaits cels that
// yield Promises, so this is just a slow cel — no special handling
// needed by the host.
//
// Errors: malformed MJML (parse failure, validation failure with
// halt-on-error mode) propagates as a thrown Error from the runtime
// fn — runCascade lets it bubble. Validation warnings (the default
// "soft" mode) are NOT thrown; they're attached to the Error message
// only when validationLevel: "strict" is configured.
//
// Node-only for v1. mjml's dependency tree (cheerio, juice, htmlnano,
// detect-node, …) is Node-shaped. A browser variant — running mjml
// pre-bundled, or a thinner MJML→HTML reimplementation — is a
// follow-up. The Node-only floor is also declared via
// package.json's `"engines": { "node": ">=18" }` so npm and tooling
// can surface it without reading source.
//
// No `extractDeps`. The compiler envelope intentionally omits the
// optional `extractDeps` hook. MJML source doesn't declaratively
// reference cels — `{{name}}` is post-hoc templating substituted at
// fire time, not a compile-time reference the kernel can statically
// analyse. (Compare formula cels, where the body literally names the
// cels it reads, and `extractDeps` parses them out.) Users must
// therefore wire an `inputMap` on every MJML cel by hand, mapping each
// `{{name}}` token to a cel key. The demo at examples/mjml-demo
// illustrates the convention.
// ============================================================================

export const PLASTRON_MJML_SEGMENT = "plastron-mjml" as const;
export const MJML_LAMBDA_KEY: LambdaKey = "mjml";

/** Manifest for the plastron-mjml segment. Declares the lambda kind
 *  it registers ("mjml" — the compiler) and the cel segment it
 *  manages. No `dependsOn`: the compiler is leaf-level — cels with
 *  cel.l = "mjml" reference it by registry key, not by import. */
export const plastronMjmlManifest: SegmentManifest = {
  segment: PLASTRON_MJML_SEGMENT,
  version: "0.0.1",
  description:
    "MJML compiler kind — cels with cel.l = 'mjml' compile MJML source to HTML.",
  provides: {
    lambdas: [MJML_LAMBDA_KEY],
    celSegments: [PLASTRON_MJML_SEGMENT],
  },
};

// ----------------------------------------------------------------------------
// mjml2html resolution
//
// `mjml` is published as CJS with `module.exports = mjml2html`. Under
// ESM `import * as mjmlPkg from "mjml"` gives us a namespace whose
// `.default` is the function. We tolerate either shape (some bundlers
// hoist the function onto the namespace itself) so the same source
// works through Vite, esbuild, raw tsx, and node.
// ----------------------------------------------------------------------------

interface Mjml2HtmlOptions {
  /** "soft" (default) collects validation issues; "strict" throws on
   *  the first one. We expose this so callers who care about strict
   *  validation can opt in. */
  validationLevel?: "strict" | "soft" | "skip";
  /** Beautify the HTML output. Default false (mjml-core's default). */
  beautify?: boolean;
  /** Minify the HTML output. Default false. */
  minify?: boolean;
  /** When set, mjml uses this as the base path for `mj-include`
   *  resolution. We pass it through unchanged when supplied. */
  filePath?: string;
}

interface Mjml2HtmlResult {
  html: string;
  errors?: Array<{ formattedMessage?: string; message?: string }>;
}

type Mjml2Html = (
  input: string,
  options?: Mjml2HtmlOptions,
) => Promise<Mjml2HtmlResult> | Mjml2HtmlResult;

const resolveMjml2Html = (): Mjml2Html => {
  const ns: unknown = mjmlPkg;
  if (typeof ns === "function") return ns as Mjml2Html;
  if (typeof ns === "object" && ns !== null) {
    const dflt = (ns as { default?: unknown }).default;
    if (typeof dflt === "function") return dflt as Mjml2Html;
  }
  throw new Error(
    "plastron-mjml: could not resolve mjml2html from the 'mjml' package " +
    "(expected a function or a default export).",
  );
};

const mjml2html = resolveMjml2Html();

// ----------------------------------------------------------------------------
// Templating
//
// Pre-process the source by replacing `{{ name }}` tokens with the
// matching input value, HTML-escaped. Whitespace inside the braces is
// tolerated. Tokens whose names aren't in the inputs map are left as-is
// so a typo surfaces as a visible `{{name}}` in the rendered email
// rather than a silent empty string.
// ----------------------------------------------------------------------------

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const stringifyInput = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects / arrays — JSON-encode so the rendered output is at least
  // inspectable. Cels feeding mjml are expected to be primitives most
  // of the time; this is the fallback for richer shapes.
  try { return JSON.stringify(v); }
  catch { return String(v); }
};

/** Substitute `{{name}}` tokens in `source` with HTML-escaped values
 *  drawn from `inputs`. Exported for testing and for hosts that want
 *  the same templating without going through the compiler. */
export const renderMjmlTemplate = (
  source: string,
  inputs: Record<string, unknown>,
): string => source.replace(TEMPLATE_TOKEN, (match, name: string) => {
  if (!Object.prototype.hasOwnProperty.call(inputs, name)) return match;
  return escapeHtml(stringifyInput(inputs[name]));
});

// ----------------------------------------------------------------------------
// Compiler
// ----------------------------------------------------------------------------

export interface MjmlCompilerOptions {
  /** Forwarded to mjml2html on every compile. The cel's source is
   *  always fed in as the first argument; these are baseline options
   *  applied to every run. Per-cel overrides are not supported in v1
   *  — drive variability through the source / inputs instead. */
  mjmlOptions?: Mjml2HtmlOptions;
}

/** Build the MJML compiler. The returned Compiler matches plastron's
 *  shape: it accepts an MJML source string and returns a runtime Fn
 *  that, when called with the cel's resolved inputs, substitutes
 *  `{{name}}` tokens, runs mjml2html, and returns the produced HTML.
 *
 *  Register at `state.fns.set("mjml", compiler)`. Hosts that want to
 *  swap their own MJML implementation (a stricter validator, a
 *  pre-bundled browser build, an MJML-flavored DSL) can register a
 *  different compiler at the same key — installMjml leaves the
 *  registry entry unlocked. */
export const createMjmlCompiler = (
  opts: MjmlCompilerOptions = {},
): Compiler => {
  const baseOptions = opts.mjmlOptions;

  const compiler: Compiler = (source: string) => ({
    fn: (async (inputs: Record<string, unknown>): Promise<string> => {
      const filled = renderMjmlTemplate(source, inputs ?? {});
      const result = await mjml2html(filled, baseOptions);
      // Strict mode collects errors that didn't throw outright (mjml's
      // validator accumulates "soft" issues even at validationLevel
      // "strict" for some violations). Surface them rather than
      // silently rendering broken HTML.
      if (
        baseOptions?.validationLevel === "strict" &&
        result.errors && result.errors.length > 0
      ) {
        // Bound the joined message: a pathological MJML document can
        // accumulate dozens of errors, each with a long formatted
        // message containing a stack and source quote. Cap to the
        // first 5 errors and ~2KB of joined text; surface the residual
        // count so callers know they're seeing a summary, not the
        // whole story.
        const MAX_ERRORS = 5;
        const MAX_LEN = 2048;
        const total = result.errors.length;
        const head = result.errors
          .slice(0, MAX_ERRORS)
          .map((e) => e.formattedMessage ?? e.message ?? "(unknown)");
        let summary = head.join("; ");
        if (summary.length > MAX_LEN) {
          summary = `${summary.slice(0, MAX_LEN)}…`;
        }
        const remaining = total - Math.min(total, MAX_ERRORS);
        if (remaining > 0) {
          summary = `${summary} (…and ${remaining} more)`;
        }
        throw new Error(`plastron-mjml: validation failed — ${summary}`);
      }
      return result.html;
    }) as Fn,
    dispose: () => { /* MJML compile is a pure transform; no resources to free. */ },
  });
  return compiler;
};

// ----------------------------------------------------------------------------
// installMjml — register the compiler + manifest on a State.
// ----------------------------------------------------------------------------

export interface InstallMjmlOptions {
  /** Compiler options forwarded to mjml2html on every cel evaluation. */
  mjmlOptions?: Mjml2HtmlOptions;
  /** Override the registry key. Default "mjml". A host with a custom
   *  MJML dialect can register additional compilers at "mjml-strict",
   *  "mjml-mobile", etc. by calling installMjml twice with different
   *  keys; each call attaches its own manifest entry. */
  lambdaKey?: LambdaKey;
}

export interface MjmlHandle {
  /** The lambda key the compiler was registered under. */
  lambdaKey: LambdaKey;
  /** The compiler itself, in case the host wants to feed it a source
   *  string directly (testing, pre-warming, devtools). */
  compiler: Compiler;
}

/** Install the plastron-mjml compiler on an existing State. Registers
 *  the compiler at state.fns.set(options.lambdaKey ?? "mjml") and
 *  attaches a SegmentManifest at state.segments. The registry entry
 *  is unlocked — matches the formula compiler convention so hosts can
 *  swap in their own MJML implementation by re-registering at the
 *  same key.
 *
 *  Teardown: call `state.fns.get("flush")(state, "plastron-mjml")` to
 *  drop the manifest. The compiler stays in state.fns until something
 *  overwrites or deletes it. */
export const installMjml = (
  state: State,
  options: InstallMjmlOptions = {},
): MjmlHandle => {
  const lambdaKey = options.lambdaKey ?? MJML_LAMBDA_KEY;
  const compiler = createMjmlCompiler({ mjmlOptions: options.mjmlOptions });

  // Mirror hydrate.ts:244 — refuse to overwrite a host-locked entry at
  // this lambda key. Going through state.fns.set directly bypasses the
  // hydrate path's locked-fn check, so re-implement it here. An
  // unlocked entry (the formula-compiler convention; what installMjml
  // itself writes) is still freely swappable.
  if (state.fns.has(lambdaKey) && state.fnMetadata.get(lambdaKey)?.locked) {
    throw new Error(
      `plastron-mjml: refusing to overwrite locked lambda "${lambdaKey}". ` +
      `Pass a different lambdaKey to installMjml, or unlock the existing ` +
      `entry first.`,
    );
  }

  state.fns.set(lambdaKey, compiler);
  // Don't register fnMetadata as locked — keep the compiler swappable
  // by hosts (matches the unlocked "f" entry in coreFnMetadata).
  state.fnMetadata.set(lambdaKey, { key: lambdaKey, locked: false });

  const manifest: SegmentManifest =
    lambdaKey === MJML_LAMBDA_KEY
      ? plastronMjmlManifest
      : {
          ...plastronMjmlManifest,
          provides: {
            ...plastronMjmlManifest.provides,
            lambdas: [lambdaKey],
          },
        };
  state.segments.set(manifest.segment, manifest);

  return { lambdaKey, compiler };
};
