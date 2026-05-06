# `plastron-archive` segment

Read and write plastron documents to disk as `.甲` files — single canonical-JSON archives that bundle every segment, manifest, fingerprint, and dependency declaration into one self-contained, diffable artifact.

## File format

`.甲` is the canonical extension; loaders also accept `.turtle`, `.plastron`, and `.plast` for environments that mangle Unicode filenames. The file is canonical JSON (sorted keys, no whitespace) so it diffs cleanly in git and round-trips byte-identically.

```jsonc
{
  "manifest": {
    "version": 1,
    "format": "application/vnd.plastron.甲",
    "fingerprint": "abc123…",
    "createdAt": "2026-05-06T...",
    "createdBy": { "agent": "claude-opus-4.7", "user": "ian" },
    "requires": {
      "engineVersion": ">=0.0.1",
      "kinds":     ["augur", "native"],
      "tags":      ["crack"],
      "segments":  ["audit-log"],
      "nativeLambdas": ["carveCrack", "renderOmen"]
    },
    "manifest": { /* optional Ed25519 seal over the whole body */ }
  },
  "bundles": [ /* canonical SegmentBundle[] — each may carry its own per-bundle manifest */ ],
  "auditLog": [ /* optional captured AuditEvent[] */ ]
}
```

The `manifest.manifest` is the **archive seal** (a 印 over the bound stack of scrolls); per-bundle manifests inside `bundles[]` are the temple's seal on individual scrolls. Both layers verify independently.

## Usage

### Export

```ts
import { exportArchive } from "plastron-archive";
import { writeFile } from "node:fs/promises";

const archive = await exportArchive(state, {
  includeAuditLog: true,
  createdBy: { agent: "claude-opus-4.7", user: "ian" },
});
await writeFile("oracle.甲", archive, "utf8");
```

The exporter automatically derives `requires` from the State — every kind handler registered, every tag protocol, every userland segment, every native-lambda key actually referenced by a `cel.l` field. Pass `requires` explicitly to override.

### Sign on export

`plastron-archive` stays dependency-free by accepting a sign callback rather than importing crypto directly. In practice you'd pair it with `plastron-trust`:

```ts
import { signEd25519, generateKeyPair } from "plastron-trust";

const { publicKey, privateKey } = await generateKeyPair();
const signed = await exportArchive(state, {
  signWith: { privateKey, publicKey, signerName: "Temple of 殷", signEd25519 },
});
```

### Import

```ts
import { importArchive } from "plastron-archive";

const blob = await readFile("oracle.甲", "utf8");
const rt = await importArchive(blob, {
  fnRegistry: myNativeLambdas,           // covers requires.nativeLambdas
  kinds:      { augur: augurKind },      // covers requires.kinds
  tags:       { crack: crackTag },       // covers requires.tags
  segmentResolver: async (name, state) => {
    if (name === "audit-log") return installAuditLog(state);
    if (name === "plastron-trust") return installPlastronTrust(state, ...);
    throw new Error(`unknown segment: ${name}`);
  },
});
```

The loader validates `requires` *before* hydration. If anything is missing, it throws a single error listing every missing piece — kinds, tags, segments, native lambdas, engine version — so you fix them all at once instead of one round-trip per missing dep.

### Verify on import

```ts
import { verifyEd25519 } from "plastron-trust";

const rt = await importArchive(blob, {
  fnRegistry: myFns,
  kinds, tags, segmentResolver,
  verifyArchive: async (_body, manifest) => {
    const ok = await verifyEd25519(manifest.contentHash!, manifest.signature!, manifest.signerPublicKey!);
    return { ok, reason: ok ? "verified" : "bad signature" };
  },
});
```

The loader checks the archive's content hash automatically; the `verifyArchive` callback decides whether the signer's identity is acceptable.

## What's archived, what isn't

**Archived:**
- Every userland segment's cels and their lambda metadata
- Per-segment manifests (with their content hashes and signatures)
- Provenance fields on every cel (`authoredBy`, `generatedAt`, `promptId`, `agentModel`)
- Tagged values (the `__tag` and `value` fields)
- Audit-log events (if `includeAuditLog: true`)
- Top-level archive manifest with fingerprint, requires, optional seal

**Not archived:**
- Native function references — only their *keys*. Host's `FnRegistry` re-supplies them on import.
- Runtime-only reserved cels (`config`, `indexes`, `state`, `input`)
- The `auditLog` segment's cels themselves — the events go in `body.auditLog` separately so the host can decide to replay, drop, or merge them. The segment is re-installed fresh on import to capture *future* events.
- Hook subscriber callbacks (the segments that own them are re-installed via `segmentResolver`)
- WASM-resident handles for opaque tagged values that declared themselves non-serializable

## Dependency declaration — the `requires` block

The whole point of `requires` is **fail-fast at load**. Without it, an archive that references the `python` kind or expects `audit-log` would hydrate fine and then explode mid-cycle when something invoked the missing piece. With `requires`, the loader inspects the host's environment up front and throws one combined error listing every missing dependency. The host fixes them all and tries again.

The exporter derives `requires` automatically — there's no manual declaration step. Plastron's `fingerprintComponents()` already enumerates every registered kind, tag, hook, and segment; the exporter walks `state.Cels` to find every native-lambda key actually referenced. The result is a precise dependency manifest tied to what the document literally needs, not what it might theoretically use.

## What this gives you beyond Excel-style export

- **Reproducibility.** Two runtimes that load the same `.甲` file produce byte-identical fingerprints. Different fingerprint → different runtime composition.
- **Auditability.** Every cel carries provenance; every segment may carry its own signature; the archive itself may carry a top-level seal. A regulator-grade audit trail of "what was in this document, who signed it, when, by whom."
- **Diffability.** Canonical JSON is text. Two `.甲` files diff cleanly in git, GitHub, any text comparison tool.
- **Portability.** The dependency declaration means a `.甲` produced by one host can be loaded by any other host that satisfies the requires block.
- **Self-description.** `componentSnapshot` records the runtime composition for diagnostics — "why did the seal change?" is answerable from the file alone.

## Future work

- **ZIP variant** for archives with binary blobs (large audio/video for plastromancy-style transcription pipelines, embedding vectors, image attachments). Same logical structure inside; different on-disk shape.
- **Streaming export/import** for archives too large to fit in memory.
- **Diff helpers** — `diffArchives(a, b)` returning a structured changeset for two `.甲` files.
- **Migration support** — version-bump path when `ARCHIVE_FORMAT_VERSION` increments past 1.
