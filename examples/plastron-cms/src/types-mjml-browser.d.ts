// Ambient declaration for mjml-browser (no @types package available).
// Surface we use is just the default export: source string in, html out.
declare module "mjml-browser" {
  interface Mjml2HtmlResult {
    html: string;
    errors: Array<{ formattedMessage?: string; message?: string; line?: number }>;
  }
  const mjml2html: (source: string, options?: Record<string, unknown>) => Mjml2HtmlResult;
  export default mjml2html;
}
