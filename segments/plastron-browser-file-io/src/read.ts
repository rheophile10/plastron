// ========================================================================
// File reading helpers — bytes / text from a Blob | File.
//
// Modern browsers ship Blob.prototype.arrayBuffer() and Blob.prototype.text(),
// which return Promises directly. We use those for the utf-8 / bytes
// fast paths and only fall back to FileReader when a non-utf-8 encoding
// is requested (FileReader.readAsText supports a label argument; the
// promise-based Blob.text() is utf-8-only).
// ========================================================================

import { requireBrowser } from "./env.js";

export const readAsBytes = async (file: Blob): Promise<Uint8Array> => {
  requireBrowser();
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
};

/** Read the file as text. Default encoding is utf-8. Pass an encoding
 *  label like "windows-1252" or "shift_jis" to use FileReader's
 *  TextDecoder-backed path. */
export const readAsText = async (
  file: Blob,
  encoding?: string,
): Promise<string> => {
  requireBrowser();
  if (!encoding || encoding.toLowerCase() === "utf-8" || encoding.toLowerCase() === "utf8") {
    return file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsText(file, encoding);
  });
};
