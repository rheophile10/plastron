// ============================================================================
// Zero-dependency ZIP writer/reader. Container only — no third-party lib.
// DEFLATE is provided by the platform's CompressionStream("deflate-raw")
// (present in browsers, Bun, and Node ≥18 as a global); when a member doesn't
// shrink we store it uncompressed. Output is a standard .zip readable by any
// OS extractor (validated against `unzip` in test). No ZIP64 — segment
// bundles are well under 4 GB.
//
// The kernel ships no DOM/Node lib types, so CompressionStream is reached
// through a globalThis cast (the same pattern csp.ts uses for WebAssembly).
// TextEncoder/TextDecoder are used bare — file-store already does.
// ============================================================================

export interface ZipEntry { path: string; bytes: Uint8Array; }

// ── platform DEFLATE via CompressionStream ──────────────────────────────────

interface StreamWriter { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; }
interface StreamReader { read(): Promise<{ done: boolean; value?: Uint8Array }>; }
interface XformStream {
  readable: { getReader(): StreamReader };
  writable: { getWriter(): StreamWriter };
}
type XformCtor = new (format: string) => XformStream;

const CompressionStreamCtor =
  (globalThis as { CompressionStream?: XformCtor }).CompressionStream;
const DecompressionStreamCtor =
  (globalThis as { DecompressionStream?: XformCtor }).DecompressionStream;

const runStream = async (ctor: XformCtor | undefined, bytes: Uint8Array): Promise<Uint8Array> => {
  if (!ctor) {
    throw new Error(
      "archive/zip: CompressionStream/DecompressionStream is unavailable in this runtime — " +
      "DEFLATE requires a platform with the Compression Streams API (browser, Bun, Node ≥18).",
    );
  }
  const stream = new ctor("deflate-raw");
  const writer = stream.writable.getWriter();
  // Write + close concurrently with the read loop so a full internal buffer
  // can't deadlock the pipe.
  const writeDone = (async () => { await writer.write(bytes); await writer.close(); })();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  await writeDone;
  return concat(chunks, total);
};

const deflateRaw = (b: Uint8Array): Promise<Uint8Array> => runStream(CompressionStreamCtor, b);
const inflateRaw = (b: Uint8Array): Promise<Uint8Array> => runStream(DecompressionStreamCtor, b);

// ── CRC-32 (IEEE 802.3) ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// ── helpers ─────────────────────────────────────────────────────────────────

const concat = (parts: Uint8Array[], total?: number): Uint8Array => {
  const n = total ?? parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

const STORE = 0;
const DEFLATE = 8;

// ── write ───────────────────────────────────────────────────────────────────

export const zipBytes = async (entries: ZipEntry[]): Promise<Uint8Array> => {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.bytes);
    const rawSize = e.bytes.length;
    const deflated = await deflateRaw(e.bytes);
    const method = deflated.length < rawSize ? DEFLATE : STORE;
    const data = method === DEFLATE ? deflated : e.bytes;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header sig
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(6, 0, true);            // flags
    lh.setUint16(8, method, true);       // compression method
    lh.setUint16(10, 0, true);           // mod time
    lh.setUint16(12, 0x21, true);        // mod date (1980-01-01, valid)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // compressed size
    lh.setUint32(22, rawSize, true);     // uncompressed size
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);           // extra len
    local.push(new Uint8Array(lh.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);   // central dir header sig
    cd.setUint16(4, 20, true);           // version made by
    cd.setUint16(6, 20, true);           // version needed
    cd.setUint16(8, 0, true);            // flags
    cd.setUint16(10, method, true);
    cd.setUint16(12, 0, true);           // mod time
    cd.setUint16(14, 0x21, true);        // mod date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, rawSize, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);           // extra len
    cd.setUint16(32, 0, true);           // comment len
    cd.setUint16(34, 0, true);           // disk number
    cd.setUint16(36, 0, true);           // internal attrs
    cd.setUint32(38, 0, true);           // external attrs
    cd.setUint32(42, offset, true);      // local header offset
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralBytes = concat(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);   // end of central dir sig
  eocd.setUint16(4, 0, true);            // disk number
  eocd.setUint16(6, 0, true);            // central dir start disk
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralBytes.length, true);
  eocd.setUint32(16, offset, true);      // central dir offset
  eocd.setUint16(20, 0, true);           // comment len

  return concat([...local, centralBytes, new Uint8Array(eocd.buffer)]);
};

// ── read ────────────────────────────────────────────────────────────────────

export const unzipBytes = async (zip: Uint8Array): Promise<ZipEntry[]> => {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder();

  // Locate the End Of Central Directory by scanning back for its signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("archive/zip: no end-of-central-directory record");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("archive/zip: corrupt central directory");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const path = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));

    // The local header repeats name/extra lengths; data follows them.
    const lhNameLen = dv.getUint16(localOff + 26, true);
    const lhExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    const bytes = method === DEFLATE ? await inflateRaw(data) : data.slice();

    out.push({ path, bytes });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};
