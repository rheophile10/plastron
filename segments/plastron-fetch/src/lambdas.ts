import type { Fn } from "../../../plastron/src/index.js";
import type { FetchHeaders, FetchRequest, FetchResponse } from "./schemas.js";

// ========================================================================
// Lambdas — fetchJson / fetchText / fetchBytes.
//
// Lambda-input convention: every kernel-invoked lambda receives a
// single `inputs: Record<string, unknown>` object whose keys come from
// `cel.inputMap`. To match that, our lambdas destructure `{ request }`
// (and optionally `{ signal }`). A consumer wires them via:
//
//   {
//     key: "userResponse",
//     l: "fetchJson",
//     inputMap: { request: "userRequest" },
//   }
//
// `userRequest` is a value cel holding a `FetchRequest`. To support
// abort, add a second slot `signal: "userAbortSignalCel"` whose value
// is an `AbortSignal`.
//
// Error policy: errors are returned as values, never thrown. A failed
// fetch settles into `cel.v` as `{ data, ok: false, error }` so the
// cascade keeps moving and downstream cels can pattern-match. Async
// lambdas in plastron settle into `cel.v` and propagate through
// Promise.all at level barriers — a thrown error would poison the
// entire wave.
// ========================================================================

export const FETCH_JSON_KEY  = "fetchJson"  as const;
export const FETCH_TEXT_KEY  = "fetchText"  as const;
export const FETCH_BYTES_KEY = "fetchBytes" as const;

interface RuntimeInputs {
  request: FetchRequest | undefined;
  signal?: AbortSignal;
}

type ParseMode = "json" | "text" | "bytes";

const isPlainJsonShape = (b: unknown): boolean => {
  if (b === null || b === undefined) return false;
  if (typeof b !== "object") return false;
  // Bail out on platform body types — they ship as-is, the platform sets
  // their content-type.
  if (typeof FormData !== "undefined" && b instanceof FormData) return false;
  if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return false;
  if (b instanceof Uint8Array) return false;
  if (b instanceof ArrayBuffer) return false;
  if (typeof Blob !== "undefined" && b instanceof Blob) return false;
  if (typeof ReadableStream !== "undefined" && b instanceof ReadableStream) return false;
  return true;
};

const hasContentTypeHeader = (headers: FetchHeaders | undefined): boolean => {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return true;
  }
  return false;
};

interface PreparedBody {
  body?: BodyInit | null;
  contentType?: string;
}

const prepareBody = (req: FetchRequest): PreparedBody => {
  const b = req.body;
  if (b === null || b === undefined) return {};

  if (typeof b === "string")        return { body: b };
  if (b instanceof Uint8Array)      return { body: b as unknown as BodyInit };
  if (b instanceof ArrayBuffer)     return { body: b as unknown as BodyInit };
  if (typeof FormData !== "undefined" && b instanceof FormData) {
    return { body: b as unknown as BodyInit };
  }
  if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) {
    return { body: b as unknown as BodyInit };
  }
  if (typeof Blob !== "undefined" && b instanceof Blob) {
    return { body: b as unknown as BodyInit };
  }
  if (typeof ReadableStream !== "undefined" && b instanceof ReadableStream) {
    return { body: b as unknown as BodyInit };
  }

  if (isPlainJsonShape(b)) {
    return {
      body: JSON.stringify(b),
      contentType: "application/json",
    };
  }
  // Fallback: stringify whatever it is. This catches numbers, booleans,
  // and anything else a host might pass.
  return { body: String(b) };
};

const collectResponseHeaders = (res: Response): FetchHeaders => {
  const out: FetchHeaders = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};

// Single shared runner — the three exported lambdas only differ in
// which body parser they apply.
const runFetch = async (
  inputs: RuntimeInputs,
  mode: ParseMode,
): Promise<FetchResponse> => {
  const req = inputs.request;
  if (!req || typeof req !== "object" || typeof req.url !== "string") {
    return {
      data: null,
      ok: false,
      error: "missing or malformed request (expected { url, ... })",
    };
  }

  const method = req.method ?? "GET";
  const headers: FetchHeaders = req.headers ? { ...req.headers } : {};
  const prepared = prepareBody(req);

  // Auto-set Content-Type only if the host hasn't supplied one.
  if (prepared.contentType && !hasContentTypeHeader(headers)) {
    headers["Content-Type"] = prepared.contentType;
  }

  const init: RequestInit = { method, headers };
  if (prepared.body !== undefined) init.body = prepared.body;
  if (inputs.signal) init.signal = inputs.signal;

  let res: Response;
  try {
    res = await fetch(req.url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface aborts with a stable token; everything else carries the
    // platform error message.
    const isAbort =
      (err instanceof Error && err.name === "AbortError") ||
      message.toLowerCase().includes("aborted");
    return {
      data: null,
      ok: false,
      error: isAbort ? "aborted" : message,
    };
  }

  const status = res.status;
  const responseHeaders = collectResponseHeaders(res);
  const httpOk = res.ok;

  let data: unknown = null;
  let parseError: string | undefined;
  try {
    if (mode === "json") {
      // Some servers respond 204 / empty body — text() then JSON.parse so
      // an empty body becomes null instead of throwing.
      const txt = await res.text();
      data = txt.length === 0 ? null : JSON.parse(txt);
    } else if (mode === "text") {
      data = await res.text();
    } else {
      const ab = await res.arrayBuffer();
      data = new Uint8Array(ab);
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  if (httpOk && !parseError) {
    return { data, status, headers: responseHeaders, ok: true };
  }

  // Failure path — both HTTP-level and parse-level. When both apply,
  // concatenate so the status doesn't get hidden by the parse failure.
  let error: string;
  if (!httpOk && parseError) {
    error = `HTTP ${status}: ${parseError}`;
  } else if (!httpOk) {
    error = `HTTP ${status}`;
  } else {
    error = parseError ?? "unknown parse failure";
  }

  return { data, status, headers: responseHeaders, ok: false, error };
};

// Public lambdas. Kernel calls these with `inputs: Record<string, unknown>`
// — we destructure `{ request }` (and optional `{ signal }`) so the
// host's `inputMap: { request: "...", signal: "..." }` Just Works.

export const fetchJson: Fn = async (
  inputs: RuntimeInputs,
): Promise<FetchResponse> => runFetch(inputs, "json");

export const fetchText: Fn = async (
  inputs: RuntimeInputs,
): Promise<FetchResponse> => runFetch(inputs, "text");

export const fetchBytes: Fn = async (
  inputs: RuntimeInputs,
): Promise<FetchResponse> => runFetch(inputs, "bytes");
