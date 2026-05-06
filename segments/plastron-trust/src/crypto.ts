// ========================================================================
// Crypto helpers — Ed25519 sign + verify via Web Crypto.
//
// Available natively in modern browsers (Chrome 116+, Firefox 130+,
// Safari 16+) and Node 18.5+. globalThis.crypto.subtle is the same
// surface in both. The "Ed25519" algorithm name is what WebCrypto
// expects.
//
// Keys are exchanged as lowercase-hex strings — small (32 bytes / 64
// hex chars for Ed25519) and easy to embed in manifests, env vars, or
// configuration files.
// ========================================================================

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      "globalThis.crypto.subtle is not available. plastron-trust requires modern browsers or Node 18.5+."
    );
  }
  return s;
};

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex string length: ${clean.length}`);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const bytesToHex = (bytes: Uint8Array | ArrayBuffer): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
};

// ------------------------------------------------------------------------
// Key generation — useful for tests, CI, and bootstrapping a new signer.
// ------------------------------------------------------------------------

export interface KeyPairHex {
  publicKey: string;
  privateKey: string;
}

export const generateKeyPair = async (): Promise<KeyPairHex> => {
  const pair = await subtle().generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const pubRaw = await subtle().exportKey("raw", pair.publicKey);
  // PKCS#8 is the only Ed25519 private-key export format Web Crypto offers.
  const privRaw = await subtle().exportKey("pkcs8", pair.privateKey);
  return {
    publicKey: bytesToHex(pubRaw),
    privateKey: bytesToHex(privRaw),
  };
};

// ------------------------------------------------------------------------
// Sign / verify.
// ------------------------------------------------------------------------

const importPublicKey = async (publicKeyHex: string): Promise<CryptoKey> =>
  subtle().importKey(
    "raw",
    toArrayBuffer(hexToBytes(publicKeyHex)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );

const importPrivateKey = async (privateKeyHex: string): Promise<CryptoKey> =>
  subtle().importKey(
    "pkcs8",
    toArrayBuffer(hexToBytes(privateKeyHex)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );

/** Sign UTF-8 data with an Ed25519 private key (hex). Returns hex signature. */
export const signEd25519 = async (data: string, privateKeyHex: string): Promise<string> => {
  const key = await importPrivateKey(privateKeyHex);
  const bytes = new TextEncoder().encode(data);
  const sig = await subtle().sign("Ed25519", key, toArrayBuffer(bytes));
  return bytesToHex(sig);
};

/** Verify an Ed25519 signature (hex) over UTF-8 data, against a public key (hex). */
export const verifyEd25519 = async (
  data: string,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> => {
  try {
    const key = await importPublicKey(publicKeyHex);
    const dataBytes = new TextEncoder().encode(data);
    const sigBytes = hexToBytes(signatureHex);
    return await subtle().verify(
      "Ed25519",
      key,
      toArrayBuffer(sigBytes),
      toArrayBuffer(dataBytes),
    );
  } catch {
    return false;
  }
};
