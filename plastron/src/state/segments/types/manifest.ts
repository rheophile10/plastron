import type { Key } from "../../../common.js";

// ========================================================================
// SegmentManifest — optional cryptographic envelope around a segment.
// Plastron core knows about the manifest's *shape* but does not perform
// signing or verification itself; that lives in the plastron-trust
// extension package and is invoked via HydrateOptions.verifySegment.
// In phase 1, the default verifier accepts everything; manifests are
// recorded but not enforced.
// ========================================================================

export interface SegmentCapabilities {
  /** Lambda kinds this segment registers (e.g. ["python", "sqlite"]). */
  kinds?: string[];
  /** Hook subscription points this segment listens on. */
  hooks?: string[];
  /** Format-tag protocols this segment registers. */
  tags?: string[];
  /** input.* methods this segment invokes. */
  input?: Array<"get" | "set" | "batch" | "touch" | "consume">;
}

export interface SegmentManifest {
  /** sha256 hex over the canonical serialization of the bundle, with
   *  the manifest stripped out (otherwise the hash would be circular). */
  contentHash?: string;
  /** Detached signature over contentHash, produced by signerPublicKey. */
  signature?: string;
  /** Public key (Ed25519, hex or base64) corresponding to the signer. */
  signerPublicKey?: string;
  /** Identifier for the signer's identity (email, GitHub login, etc.).
   *  Display only — trust decisions consult signerPublicKey. */
  signerName?: string;
  /** Declared capability scope for verification. */
  capabilities?: SegmentCapabilities;
  /** Map of segment-key → expected contentHash for transitive verification. */
  dependencies?: Record<Key, string>;
  /** ISO-8601 timestamp at which the manifest was signed. */
  signedAt?: string;
  /** ISO-8601 expiry; verifiers may refuse signed segments past this. */
  expiresAt?: string;
}

export interface VerificationResult {
  /** Whether the segment is permitted to load. */
  ok: boolean;
  /** Free-form reason; surfaced in errors and audit logs. */
  reason?: string;
  /** Verifier identity (e.g. "plastron-trust@strict") for audit. */
  verifier?: string;
}
