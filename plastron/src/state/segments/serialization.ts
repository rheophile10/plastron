import type { SegmentBundle } from "./types/bundle.js";
import { BUNDLE_FORMAT_VERSION } from "./types/bundle.js";

// ========================================================================
// Canonical serialization
//
// Produces byte-identical JSON for byte-identical content, regardless
// of platform or insertion order. Used for:
//
//   • Segment hashing — content hash inside SegmentManifest.
//   • Runtime fingerprint — over kinds + hooks + segments + policy.
//   • Anywhere two parties (signer/verifier, parent/worker plastron)
//     need to agree on a stable representation of the same data.
//
// Rules:
//   1. Object keys are sorted lexicographically.
//   2. No insignificant whitespace.
//   3. Numbers via standard JSON.stringify (NaN/Infinity → null per
//      JSON; -0 → "0"). For exact preservation of these, use a
//      format-tagged value with a custom serializer.
//   4. Undefined is dropped (treated as absent).
//   5. Arrays preserve order.
// ========================================================================

const canonicalSort = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalSort);

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    sorted[k] = canonicalSort(v);
  }
  return sorted;
};

/** Canonical JSON string: sorted keys, no whitespace, deterministic. */
export const canonicalize = (value: unknown): string =>
  JSON.stringify(canonicalSort(value));

// ------------------------------------------------------------------------
// SHA-256 helper. Uses globalThis.crypto.subtle, available in modern
// browsers and Node 19+. Returns lowercase hex.
// ------------------------------------------------------------------------

const hexFromBytes = (buf: ArrayBuffer): string => {
  const arr = new Uint8Array(buf);
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
};

export const sha256Hex = async (input: string | Uint8Array): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "globalThis.crypto.subtle is not available. Plastron canonical hashing requires modern browsers or Node 19+."
    );
  }
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  // Copy into a fresh ArrayBuffer — narrows the BufferSource type to
  // ArrayBuffer (vs. ArrayBufferLike, which subtle.digest now refuses).
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await subtle.digest("SHA-256", buffer);
  return hexFromBytes(digest);
};

// ------------------------------------------------------------------------
// Bundle helpers — content hash, version validation.
// ------------------------------------------------------------------------

/** Compute the canonical content hash of a bundle. The bundle's own
 *  manifest is excluded from the hash (otherwise circular: the hash
 *  goes inside the manifest). */
export const bundleContentHash = async (bundle: SegmentBundle): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { manifest: _ignored, ...rest } = bundle;
  return await sha256Hex(canonicalize(rest));
};

/** Validate that a bundle's version is supported. Throws on mismatch. */
export const validateBundleVersion = (bundle: SegmentBundle): void => {
  if (bundle.version !== BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Segment bundle "${bundle.key}" declares version ${String(bundle.version)} but ` +
      `this plastron supports version ${BUNDLE_FORMAT_VERSION}.`
    );
  }
};
