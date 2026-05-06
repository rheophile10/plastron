import type {
  SegmentBundle, SegmentManifest, VerificationResult,
} from "../../../plastron/src/index.js";
import { bundleContentHash } from "../../../plastron/src/index.js";
import { signEd25519, verifyEd25519 } from "./crypto.js";

export {
  generateKeyPair, signEd25519, verifyEd25519,
  type KeyPairHex,
} from "./crypto.js";

// ========================================================================
// plastron-trust — verifySegment policy + manifest signing helpers.
//
// Three policy modes:
//
//   permissive — record verification results (signature, hash, signer)
//                but accept all bundles. Good for development; produces
//                an audit trail without enforcement.
//
//   warning    — accept all bundles, but invoke onWarn when a bundle
//                fails any check. Good for prosumer use where a UI
//                prompt or notification handles the decision.
//
//   strict     — refuse bundles whose content hash mismatches, whose
//                signature fails to verify, or whose signer is not in
//                the trust root. Good for enterprise / regulated use.
//
// The sign helpers (signBundle) compute the canonical content hash and
// produce a manifest with a detached Ed25519 signature.
// ========================================================================

export type PolicyMode = "permissive" | "warning" | "strict";

export interface TrustRoot {
  /** Lowercase hex of the Ed25519 public key. */
  publicKey: string;
  /** Display name for audit purposes. */
  signerName: string;
  /** Optional ISO timestamp — manifests signed after this are rejected. */
  notAfter?: string;
  /** Optional ISO timestamp — manifests with expiresAt earlier are rejected. */
  notBefore?: string;
}

export interface PolicyConfig {
  mode: PolicyMode;
  trustRoots: TrustRoot[];
  /** Invoked from warning mode when a check fails. May be async; the
   *  verifier waits for it before resolving. Return true to permit, false
   *  to refuse. Defaults to permitting in warning mode. */
  onWarn?: (
    bundle: SegmentBundle,
    manifest: SegmentManifest,
    issue: string,
  ) => boolean | Promise<boolean>;
}

const VERIFIER_NAME = "plastron-trust";

const decideForIssue = async (
  config: PolicyConfig,
  bundle: SegmentBundle,
  manifest: SegmentManifest,
  issue: string,
): Promise<VerificationResult> => {
  const verifier = `${VERIFIER_NAME}@${config.mode}`;
  if (config.mode === "permissive") {
    return { ok: true, reason: `permissive — recorded: ${issue}`, verifier };
  }
  if (config.mode === "warning") {
    let permit: boolean | undefined;
    if (config.onWarn) {
      permit = await Promise.resolve(config.onWarn(bundle, manifest, issue));
    }
    if (permit === false) {
      return { ok: false, reason: `warning denied: ${issue}`, verifier };
    }
    return { ok: true, reason: `warning permitted: ${issue}`, verifier };
  }
  // strict
  return { ok: false, reason: issue, verifier };
};

/** Returns a verifier callback to drop into HydrateOptions.verifySegment. */
export const createPolicyVerifier = (config: PolicyConfig) => {
  return async (
    bundle: SegmentBundle,
    manifest: SegmentManifest,
  ): Promise<VerificationResult> => {
    // 1. Recompute the content hash and compare.
    const expectedHash = await bundleContentHash(bundle);
    if (manifest.contentHash !== expectedHash) {
      return decideForIssue(config, bundle, manifest,
        `content hash mismatch: declared ${manifest.contentHash ?? "(none)"}, computed ${expectedHash}`);
    }

    // 2. If signature is present, verify it cryptographically.
    if (manifest.signature && manifest.signerPublicKey) {
      const ok = await verifyEd25519(
        expectedHash,
        manifest.signature,
        manifest.signerPublicKey,
      );
      if (!ok) {
        return decideForIssue(config, bundle, manifest,
          `signature verification failed for ${manifest.signerName ?? manifest.signerPublicKey}`);
      }
    }

    // 3. Trust-root check — even valid signatures from unrecognised
    //    signers are refused under strict.
    const trusted = config.trustRoots.find((r) => r.publicKey === manifest.signerPublicKey);
    if (!trusted) {
      return decideForIssue(config, bundle, manifest,
        `signer not in trust root: ${manifest.signerName ?? "(anonymous)"} (${manifest.signerPublicKey ?? "no key"})`);
    }

    // 4. Temporal validity.
    if (trusted.notAfter && manifest.signedAt && manifest.signedAt > trusted.notAfter) {
      return decideForIssue(config, bundle, manifest,
        `manifest signed after notAfter: ${manifest.signedAt} > ${trusted.notAfter}`);
    }
    if (trusted.notBefore && manifest.expiresAt && manifest.expiresAt < trusted.notBefore) {
      return decideForIssue(config, bundle, manifest,
        `manifest expires before notBefore: ${manifest.expiresAt} < ${trusted.notBefore}`);
    }

    return {
      ok: true,
      verifier: `${VERIFIER_NAME}@${config.mode}`,
      reason: `verified: ${trusted.signerName}`,
    };
  };
};

// ------------------------------------------------------------------------
// Signing helpers — produce a manifest given a bundle + signer key.
// ------------------------------------------------------------------------

export interface SignOptions {
  /** Lowercase hex Ed25519 private key (PKCS#8 export). */
  privateKey: string;
  /** Public counterpart (must match TrustRoot.publicKey on the verifier). */
  publicKey: string;
  /** Display name. */
  signerName?: string;
  /** ISO timestamp; defaults to now. */
  signedAt?: string;
  /** ISO timestamp; optional. */
  expiresAt?: string;
  /** Capability declarations attached to the manifest. */
  capabilities?: SegmentManifest["capabilities"];
  /** Hashes of bundles this one depends on. */
  dependencies?: SegmentManifest["dependencies"];
}

/** Compute a content hash for the bundle and produce a signed manifest. */
export const signBundle = async (
  bundle: SegmentBundle,
  options: SignOptions,
): Promise<SegmentManifest> => {
  // Ensure we hash the bundle without any pre-existing manifest.
  const stripped: SegmentBundle = { ...bundle };
  delete stripped.manifest;
  const contentHash = await bundleContentHash(stripped);
  const signature = await signEd25519(contentHash, options.privateKey);
  const manifest: SegmentManifest = {
    contentHash,
    signature,
    signerPublicKey: options.publicKey,
  };
  if (options.signerName !== undefined)   manifest.signerName = options.signerName;
  if (options.signedAt !== undefined)     manifest.signedAt = options.signedAt;
  else                                    manifest.signedAt = new Date().toISOString();
  if (options.expiresAt !== undefined)    manifest.expiresAt = options.expiresAt;
  if (options.capabilities !== undefined) manifest.capabilities = options.capabilities;
  if (options.dependencies !== undefined) manifest.dependencies = options.dependencies;
  return manifest;
};

/** Convenience — return a copy of the bundle with a freshly-signed manifest. */
export const signBundleInPlace = async (
  bundle: SegmentBundle,
  options: SignOptions,
): Promise<SegmentBundle> => {
  const manifest = await signBundle(bundle, options);
  return { ...bundle, manifest };
};
