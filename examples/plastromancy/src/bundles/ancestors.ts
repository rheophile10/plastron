import type { SegmentBundle } from "../../../../plastron/src/index.js";
import { bundleContentHash } from "../../../../plastron/src/index.js";
import { ancestorsChiselMeta } from "../lambdas/chisels.js";

// ========================================================================
// ancestors — the sacred catalog. Read-only. Signed by the temple.
//
// Demonstrates:
//   • SegmentBundle with a manifest
//   • Content hash computed via bundleContentHash
//   • Verification via runtime options.verifySegment
//
// In a real deployment the temple would sign the hash with an Ed25519
// key kept offline; this example fills in the manifest with a content
// hash and a signer name, and the verifier accepts based on signer
// identity from a known set.
// ========================================================================

const baseAncestors: Omit<SegmentBundle, "manifest"> = {
  version: 1,
  key: "ancestors",
  metadata: {
    role: "documentation",
    description: "Sacred catalog of ancestors — read-only, signed by the temple.",
  },
  cels: {
    ancestors: {
      key: "ancestors", segment: "ancestors", readOnly: true,
      authoredBy: "Temple of 殷",
      generatedAt: "1200 BCE",
      v: [
        { name: "成湯",   title: "founder of 商 dynasty" },
        { name: "太甲",   title: "fourth king" },
        { name: "盤庚",   title: "moved capital to 殷" },
        { name: "武丁",   title: "the present king" },
      ],
    },
    ancestorReport: {
      key: "ancestorReport", segment: "ancestors",
      l: "renderAncestors",
      inputMap: { ancestors: "ancestors" },
    },
  },
  lambdas: {
    ...ancestorsChiselMeta,
  },
};

/** Pre-compute the content hash and stamp the manifest. In production
 *  this would happen offline at signing time. */
export const buildAncestorsBundle = async (): Promise<SegmentBundle> => {
  const contentHash = await bundleContentHash(baseAncestors);
  return {
    ...baseAncestors,
    manifest: {
      contentHash,
      signerName: "Temple of 殷 (寺廟)",
      signerPublicKey: "demo-key-not-real",
      signedAt: "2026-05-06T00:00:00Z",
      capabilities: {
        // The catalog is read-only. No kinds, hooks, or tags registered.
        kinds: [],
        hooks: [],
        tags: [],
      },
    },
  };
};

/** Set of recognized signer identities for the example verifier. */
export const trustedSigners: ReadonlySet<string> = new Set([
  "Temple of 殷 (寺廟)",
]);
