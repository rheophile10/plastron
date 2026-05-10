// ========================================================================
// File pickers.
//
//   pickFile(opts)        — open the browser's native picker.
//   pickFileFromDrop(ev)  — extract Files from a DragEvent.
//
// Cancellation: modern browsers fire a `cancel` event on
// <input type=file> when the user dismisses the picker. We listen for
// both `change` and `cancel`; whichever fires first resolves the
// promise. Older browsers that lack the `cancel` event leave the
// promise pending until the document is GC'd — that's the platform's
// limitation, not ours. Hosts that need a fallback can race
// pickFile(...) against their own timeout.
// ========================================================================

import { requireBrowser } from "./env.js";

export interface PickFileOptions {
  /** `accept` attribute (e.g. ".csv,.json", "image/*"). Comma-separated. */
  accept?: string;
  /** When true, returns File[] (possibly empty if cancelled). When
   *  false/unset, returns a single File or null. */
  multiple?: boolean;
}

export function pickFile(opts: { multiple: true } & PickFileOptions): Promise<File[] | null>;
export function pickFile(opts?: { multiple?: false } & PickFileOptions): Promise<File | null>;
export function pickFile(
  opts?: PickFileOptions,
): Promise<File | File[] | null> {
  requireBrowser();
  return new Promise<File | File[] | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts?.accept)   input.accept   = opts.accept;
    if (opts?.multiple) input.multiple = true;
    // Position offscreen rather than display:none — Safari has historically
    // rejected click() on display:none inputs.
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    input.setAttribute("aria-hidden", "true");

    let settled = false;
    const cleanup = (): void => {
      try { input.remove(); } catch { /* swallow */ }
    };
    const settle = (value: File | File[] | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    // `{ once: true }` removes the listener after it fires — the
    // `settled` flag still dedupes the change-then-cancel race, but
    // we don't rely on `input.remove()` GC'ing dangling listeners.
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      if (opts?.multiple) {
        settle(files);
      } else {
        settle(files[0] ?? null);
      }
    }, { once: true });
    // `cancel` is a recent addition (Chromium 113+, Safari 16.4+, Firefox
    // 91+). On older browsers this listener is just dead weight.
    input.addEventListener("cancel", () => {
      settle(opts?.multiple ? [] : null);
    }, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

/** Extract the dropped File(s) from a drag/drop DragEvent. The host is
 *  responsible for calling event.preventDefault() in the dragover and
 *  drop handlers — without that the browser navigates away from the
 *  page. We don't call it here because the helper might be invoked
 *  outside the actual handler (e.g. from a queued callback) and
 *  preventDefault past the synchronous handler window has no effect.
 *
 *  Returns an empty array when the drop carried no files (e.g. text
 *  drag, URL drag). Directory entries (DataTransferItem with kind
 *  "file" but webkitGetAsEntry → directory) are skipped — directory
 *  traversal is out of scope; use the File System Access API in a
 *  separate package if you need it. */
export const pickFileFromDrop = (event: DragEvent): File[] => {
  requireBrowser();
  const dt = event.dataTransfer;
  if (!dt) return [];

  // DataTransferItemList is the modern path; it lets us filter by kind
  // and skip non-file items. Fall back to dt.files when items isn't
  // populated (rare — older browsers, programmatic synthetic events).
  if (dt.items && dt.items.length > 0) {
    const out: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
    if (out.length > 0) return out;
  }
  if (dt.files && dt.files.length > 0) {
    return Array.from(dt.files);
  }
  return [];
};
