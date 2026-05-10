// ============================================================================
// Marquee bridge — positions the .copy-marquee overlay on each paint
// by measuring the actual DOM cells. The renderer emits the element
// with `data-start` / `data-end` attributes; this bridge measures the
// cells and writes left/top/width/height onto the overlay element.
//
// MutationObserver is the right shape because the painter mutates the
// table whenever the cycle changes anything in the grid — we get
// notified on those mutations and can re-measure. Cheaper than running
// per animation frame, exact when it counts.
// ============================================================================

const ADDR_RE = /^([A-Z]+)(\d+)$/;

const positionMarquee = (): void => {
  const marquee = document.querySelector(".copy-marquee") as HTMLElement | null;
  if (!marquee) return;
  const start = marquee.dataset.start;
  const end   = marquee.dataset.end;
  if (!start) return;
  const wrapper = document.querySelector(".grid-wrapper");
  if (!wrapper) return;

  const cellEl = (addr: string): HTMLElement | null => {
    const m = ADDR_RE.exec(addr);
    if (!m) return null;
    const col = m[1]!.charCodeAt(0) - 65;
    const row = parseInt(m[2]!, 10) - 1;
    const tr = wrapper.querySelectorAll("tbody tr")[row];
    if (!tr) return null;
    return tr.children[col + 1] as HTMLElement;
  };

  const a = cellEl(start);
  const b = cellEl(end || start);
  if (!a || !b) return;

  const wrap = wrapper.getBoundingClientRect();
  const ar = a.getBoundingClientRect();
  const br = b.getBoundingClientRect();

  const left   = Math.min(ar.left, br.left) - wrap.left;
  const top    = Math.min(ar.top,  br.top)  - wrap.top;
  const right  = Math.max(ar.right,  br.right);
  const bottom = Math.max(ar.bottom, br.bottom);
  const width  = right  - Math.min(ar.left, br.left);
  const height = bottom - Math.min(ar.top,  br.top);

  marquee.style.left   = `${left}px`;
  marquee.style.top    = `${top}px`;
  marquee.style.width  = `${width}px`;
  marquee.style.height = `${height}px`;
};

/** Wire a MutationObserver to keep the marquee positioned every time
 *  the grid mutates. Call once at startup. */
export const installMarqueeBridge = (): void => {
  const root = document.querySelector("#root");
  if (!root) return;
  new MutationObserver(positionMarquee).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-start", "data-end"],
  });
  // Catch the first appearance, in case the observer fires before we
  // have time to set up.
  positionMarquee();
};
