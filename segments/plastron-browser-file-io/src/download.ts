// ========================================================================
// downloadBytes — trigger a browser file download.
//
// Wraps the bytes in a Blob, mints a Blob URL, programmatically clicks
// an anchor with the `download` attribute, and revokes the URL on the
// next macrotask. setTimeout(0) is enough — the navigation kicked off
// by the click is dispatched synchronously, so by the time the
// callback fires the browser has already started the download.
// ========================================================================

import { requireBrowser } from "./env.js";

export const downloadBytes = (
  filename: string,
  bytes: Uint8Array | ArrayBuffer | Blob,
  mime?: string,
): void => {
  requireBrowser();

  const blob = bytes instanceof Blob
    ? bytes
    : new Blob([bytes as BlobPart], { type: mime ?? "application/octet-stream" });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer cleanup so the browser has time to honour the download. 0ms is
  // sufficient on every browser we've tested; pages that need to download
  // many files in a tight loop should batch into a zip rather than
  // racing dozens of revokeObjectURL calls.
  setTimeout(() => {
    try { a.remove(); } catch { /* swallow */ }
    URL.revokeObjectURL(url);
  }, 0);
};
