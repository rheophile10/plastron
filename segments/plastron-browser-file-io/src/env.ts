// ========================================================================
// Browser-environment guard.
//
// Every helper that touches a browser-only global goes through
// requireBrowser() at first call. We deliberately don't probe at
// module-load — installBrowserFileIo and the lambda registrations are
// pure, side-effect-free imports, so a Node host can still import this
// package (e.g. as part of a transitive dep tree) without exploding.
// The wall is at the point of use.
// ========================================================================

const ERROR_MSG = "plastron-browser-file-io requires a browser environment";

export const isBrowserEnvironment = (): boolean =>
  typeof document !== "undefined"
  && typeof File !== "undefined"
  && typeof Blob !== "undefined";

export const requireBrowser = (): void => {
  if (!isBrowserEnvironment()) throw new Error(ERROR_MSG);
};
