// Ambient declaration for the `mjml` package, which ships without
// TypeScript types. We declare just the shape we touch — the real
// surface is far larger but we only call mjml2html with at most one
// options object, so the loose types here are enough.
//
// This file is referenced from src/index.ts via a triple-slash
// directive so consumers (examples, hosts) that import this segment
// don't need to add their own declaration.

declare module "mjml" {
  export interface MjmlOptions {
    validationLevel?: "strict" | "soft" | "skip";
    beautify?: boolean;
    minify?: boolean;
    filePath?: string;
    [k: string]: unknown;
  }
  export interface MjmlError {
    formattedMessage?: string;
    message?: string;
    [k: string]: unknown;
  }
  export interface MjmlResult {
    html: string;
    errors?: MjmlError[];
    [k: string]: unknown;
  }
  type Mjml2Html = (
    input: string,
    options?: MjmlOptions,
  ) => Promise<MjmlResult> | MjmlResult;

  const mjml2html: Mjml2Html;
  export default mjml2html;
}
