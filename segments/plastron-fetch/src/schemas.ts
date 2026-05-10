import { z } from "zod";

// ========================================================================
// Schemas — FetchRequest / FetchResponse.
//
// These mirror the public API of the lambdas and travel through
// state.schemas so hosts can introspect and validate request/response
// values that flow through the cel graph.
//
// Body shapes accepted on the request side:
//   • string                         — sent as-is
//   • plain object / array (JSON)    — JSON.stringify'd; auto sets
//                                      Content-Type: application/json
//                                      when the host hasn't supplied one
//   • Uint8Array / ArrayBuffer       — sent as bytes
//   • FormData / URLSearchParams     — sent as-is (the platform sets
//                                      the Content-Type)
//   • null / undefined               — no body
//
// FetchResponse.data is the parsed payload. The shape depends on which
// lambda fired:
//   • fetchJson  → unknown (parsed JSON; null on parse failure)
//   • fetchText  → string  (or null on read failure)
//   • fetchBytes → Uint8Array (or null on read failure)
// ========================================================================

export const FETCH_REQUEST_SCHEMA_KEY  = "FetchRequest"  as const;
export const FETCH_RESPONSE_SCHEMA_KEY = "FetchResponse" as const;

export const fetchMethodSchema = z.enum([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

export type FetchMethod = z.infer<typeof fetchMethodSchema>;

export const fetchHeadersSchema = z.record(z.string(), z.string());

export type FetchHeaders = z.infer<typeof fetchHeadersSchema>;

// Body types accepted on the request. We model this loosely as
// `unknown` because zod can't usefully validate every browser body
// type (Uint8Array, FormData, URLSearchParams, ArrayBuffer, …) without
// excessive complexity for no real safety win.
export const fetchBodySchema = z.unknown().nullish();

export const fetchRequestSchema = z.object({
  url: z.string(),
  method: fetchMethodSchema.optional(),
  headers: fetchHeadersSchema.optional(),
  body: fetchBodySchema,
  // Per-request override of the default channel coalescing key. Hosts
  // wiring multiple requests through the same channel can use this to
  // group/unique requests differently from the default (which is the
  // cel key).
  coalesceKey: z.string().optional(),
});

export type FetchRequest = z.infer<typeof fetchRequestSchema>;

export const fetchResponseSchema = z.object({
  /** Parsed payload. Lambda-specific: object/array/primitive for
   *  fetchJson, string for fetchText, Uint8Array for fetchBytes. Null
   *  when the request failed before a body could be read or when
   *  parse failed. */
  data: z.unknown(),
  /** HTTP status code. Absent when the request never reached the
   *  network (e.g. a CORS-rejected URL, an aborted call before send). */
  status: z.number().optional(),
  /** Lower-cased response headers as a plain object. Absent when the
   *  request never produced a Response. */
  headers: fetchHeadersSchema.optional(),
  /** True iff status is in the 200–299 range AND the body parsed cleanly. */
  ok: z.boolean(),
  /** Human-readable error message. Present iff ok === false. */
  error: z.string().optional(),
});

export type FetchResponse = z.infer<typeof fetchResponseSchema>;
