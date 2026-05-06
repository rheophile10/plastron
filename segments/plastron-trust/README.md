# `plastron-trust` segment

Real Ed25519 signing/verification for plastron segment manifests, plus a three-mode policy verifier (`permissive` / `warning` / `strict`) you can plug straight into `HydrateOptions.verifySegment`.

## What's in the box

- **Crypto helpers** (`generateKeyPair`, `signEd25519`, `verifyEd25519`) using Web Crypto's native Ed25519. Available in modern browsers (Chrome 116+, Firefox 130+, Safari 16+) and Node 18.5+.
- **`signBundle(bundle, options)`** — compute the canonical content hash of a `SegmentBundle` (with any existing manifest stripped) and produce a signed `SegmentManifest`.
- **`createPolicyVerifier(config)`** — returns a `verifySegment` callback enforcing your trust policy. Drops directly into the runtime options.

## Policy modes

| Mode | Behaviour on failure |
|---|---|
| `permissive` | Records the verification result; accepts everything. Good for development. |
| `warning` | Invokes your `onWarn(bundle, manifest, issue)` callback. Return `false` to refuse, otherwise the bundle loads. Good for prosumer / interactive UIs. |
| `strict` | Refuses bundles on hash mismatch, signature failure, or untrusted signer. Good for enterprise / regulated. |

## Quick start

```ts
import { runtimeFromBundles } from "plastron";
import {
  generateKeyPair, signBundleInPlace, createPolicyVerifier,
} from "plastron-trust";

// 1. Generate or load a signer key (in practice: kept offline, stored in a vault).
const { publicKey, privateKey } = await generateKeyPair();

// 2. Sign a bundle.
const signed = await signBundleInPlace(myBundle, {
  privateKey, publicKey,
  signerName: "Temple of 殷",
});

// 3. Create a strict verifier with your trust root.
const verify = createPolicyVerifier({
  mode: "strict",
  trustRoots: [{ publicKey, signerName: "Temple of 殷" }],
});

// 4. Hydrate with verification.
const rt = await runtimeFromBundles([signed], myFns, {
  verifySegment: verify,
});
```

If a tampered or unsigned bundle is submitted under `strict` mode, `runtimeFromBundles` throws with a useful reason. Under `warning` mode the same call succeeds (or invokes `onWarn` for a runtime decision).

## Audit-log integration

Every verification result flows through plastron's hook surface via `afterHydrate`. Pair `plastron-trust` with the `audit-log` segment for a tamper-evident record of which segments were loaded, by which signer, under which policy, with which fingerprint:

```ts
import { installAuditLog } from "audit-log";

const rt = await runtimeFromBundles([signed], myFns, { verifySegment: verify });
await installAuditLog(rt);
```

## Notes on the threat model

- `signBundle` strips the existing manifest before hashing — the hash is over the bundle's content only.
- The signature is a detached Ed25519 signature over the content-hash string; tampering with any cell breaks both the hash and the signature.
- Trust-root keys are exchanged out of band. Plastron does not solve key distribution; pair this with whatever your org already uses (CI secrets, signing-key servers, ledger of trusted org keys).
- This package signs and verifies; it does not maintain a key revocation list. Revocation handling is application-specific.
