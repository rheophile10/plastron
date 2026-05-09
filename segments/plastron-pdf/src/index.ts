// ========================================================================
// segment: plastron-pdf
//
// Wraps pdfjs-dist into a small, position-aware text extractor.
// `readPdfPages(buf)` returns one entry per page; each page is an
// array of "rows" (text items grouped by Y coordinate, sorted left to
// right inside the row). That's the right shape for tabular PDFs like
// the Small Arms Survey holdings annex.
//
// pdfjs-dist v4 needs a worker URL set on `GlobalWorkerOptions.workerSrc`
// before the first call. We don't pin a specific URL here because
// "where the worker comes from" is bundler-specific (Vite users do
// `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`,
// CDN users use a versioned unpkg URL). Call `setPdfWorkerSrc(url)`
// once at app startup before invoking `readPdfPages`.
// ========================================================================

import * as pdfjs from "pdfjs-dist";

/** Set the worker URL for pdfjs-dist. Must be called once before the
 *  first `readPdfPages` invocation; otherwise pdfjs throws
 *  "No `GlobalWorkerOptions.workerSrc` specified". */
export const setPdfWorkerSrc = (workerSrc: string): void => {
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
};

export interface PdfTextItem {
  text: string;
  /** X coordinate in PDF user units (origin: bottom-left). */
  x: number;
  /** Y coordinate in PDF user units (origin: bottom-left). */
  y: number;
  /** Height of the glyph box, in user units. Useful as a row tolerance. */
  height: number;
  /** Width of the rendered text, in user units. */
  width: number;
}

export interface PdfRow {
  /** Average Y of the items in this row. */
  y: number;
  items: PdfTextItem[];
}

export interface PdfPage {
  /** 1-indexed page number, matching pdfjs's getPage(n) call. */
  pageNumber: number;
  width: number;
  height: number;
  rows: PdfRow[];
}

/** Parse a PDF and return per-page rows of position-tagged text items.
 *  Items are grouped into rows by Y proximity (within 0.6 × glyph
 *  height), then sorted left-to-right inside each row, then rows are
 *  returned top-to-bottom. */
export const readPdfPages = async (
  buf: ArrayBuffer | Uint8Array,
): Promise<PdfPage[]> => {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
  }).promise;

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items: PdfTextItem[] = [];
    for (const raw of content.items) {
      // pdfjs's TextItem: { str, transform: [a,b,c,d,e,f], width, height }.
      // The position is (e, f) — bottom-left of the text block in PDF
      // user units. We don't apply the page rotation; the docs we're
      // reading are upright.
      const item = raw as { str: string; transform: number[]; width: number; height: number };
      if (!item.str) continue;
      const x = item.transform[4] ?? 0;
      const y = item.transform[5] ?? 0;
      items.push({
        text: item.str,
        x, y,
        width: item.width,
        height: item.height,
      });
    }

    pages.push({
      pageNumber: n,
      width: viewport.width,
      height: viewport.height,
      rows: groupRows(items),
    });

    page.cleanup();
  }
  await doc.destroy();
  return pages;
};

/** Group items into rows by Y proximity. Tolerance is 0.6 × the
 *  median glyph height, which handles typical 10–12pt body text with
 *  the occasional sub/superscript without splitting them. */
const groupRows = (items: PdfTextItem[]): PdfRow[] => {
  if (items.length === 0) return [];

  const heights = items.map((i) => i.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 10;
  const tol = medianH * 0.6;

  const sorted = [...items].sort((a, b) => b.y - a.y); // top → bottom

  const rows: PdfRow[] = [];
  let current: PdfTextItem[] = [];
  let currentY = sorted[0]?.y ?? 0;

  for (const item of sorted) {
    if (current.length === 0 || Math.abs(item.y - currentY) <= tol) {
      current.push(item);
      // Running average — keeps the row anchor stable under noise.
      currentY = (currentY * (current.length - 1) + item.y) / current.length;
    } else {
      rows.push(finalizeRow(current));
      current = [item];
      currentY = item.y;
    }
  }
  if (current.length > 0) rows.push(finalizeRow(current));

  return rows;
};

const finalizeRow = (items: PdfTextItem[]): PdfRow => {
  items.sort((a, b) => a.x - b.x);
  const y = items.reduce((s, i) => s + i.y, 0) / items.length;
  return { y, items };
};

/** Concatenate a row's items into a single string. Inserts a space
 *  between items when the gap between them exceeds half a glyph width. */
export const rowText = (row: PdfRow): string => {
  let out = "";
  let prevEnd = -Infinity;
  for (const item of row.items) {
    const gap = item.x - prevEnd;
    if (out.length > 0 && gap > item.height * 0.3) out += " ";
    out += item.text;
    prevEnd = item.x + item.width;
  }
  return out;
};
