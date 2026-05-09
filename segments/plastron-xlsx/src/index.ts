import { unzipSync, strFromU8 } from "fflate";

// ========================================================================
// segment: plastron-xlsx
//
// Minimal SpreadsheetML reader. Hands you back rows of cells as plain
// JS values — strings for shared/inline strings, numbers for numeric
// cells, booleans for booleans. Date serial numbers are returned as
// numbers (callers can convert to Date via `excelSerialToDate`).
//
// Tradeoff vs sheetjs: this only handles what we actually need for
// the homicide / firearms datasets — single workbook, plain cells,
// shared-strings + inlineStr, no formulas, no styles, no rich text,
// no charts. ~140 LOC, one runtime dep (fflate, ~30KB).
//
// Usage:
//
//   const wb = await readXlsx(arrayBuffer);
//   const sheet = wb.sheets[0];          // or pickSheet(wb, "name")
//   for (const row of sheet.rows) {
//     console.log(row[0], row[1], row[10]);
//   }
// ========================================================================

export interface XlsxSheet {
  name: string;
  /** 0-indexed rows. Each row is a sparse array — empty cells are
   *  `undefined`. Length is the column count of the widest row. */
  rows: (CellValue | undefined)[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

export type CellValue = string | number | boolean;

/** Convert an XLSX date serial (days since 1899-12-30) to a JS Date.
 *  Useful when you know a column holds dates but the parser returned
 *  raw numbers (we can't tell from cell data alone — that's in styles). */
export const excelSerialToDate = (serial: number): Date => {
  const ms = (serial - 25569) * 86400 * 1000;
  return new Date(ms);
};

/** Find a sheet by exact name (or undefined). */
export const pickSheet = (
  wb: XlsxWorkbook,
  name: string,
): XlsxSheet | undefined => wb.sheets.find((s) => s.name === name);

/** Parse an XLSX workbook from raw bytes. */
export const readXlsx = (buf: ArrayBuffer | Uint8Array): XlsxWorkbook => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const files = unzipSync(bytes);

  const sharedStrings = parseSharedStrings(files["xl/sharedStrings.xml"]);
  const sheetIndex = parseWorkbookIndex(files);

  const sheets: XlsxSheet[] = [];
  for (const entry of sheetIndex) {
    const xml = files[entry.path];
    if (!xml) continue;
    sheets.push({
      name: entry.name,
      rows: parseSheet(xml, sharedStrings),
    });
  }
  return { sheets };
};

// ------------------------------------------------------------------------
// Shared strings.
// ------------------------------------------------------------------------

const parseSharedStrings = (data: Uint8Array | undefined): string[] => {
  if (!data) return [];
  const xml = strFromU8(data);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: string[] = [];
  // <si> can contain <t> directly OR a sequence of <r><t>…</t></r> runs
  // (rich text). We just concatenate all descendant <t> nodes per <si>.
  for (const si of Array.from(doc.getElementsByTagName("si"))) {
    let s = "";
    for (const t of Array.from(si.getElementsByTagName("t"))) {
      s += t.textContent ?? "";
    }
    out.push(s);
  }
  return out;
};

// ------------------------------------------------------------------------
// Workbook index — map sheet name → path inside the zip.
// ------------------------------------------------------------------------

interface SheetEntry { name: string; path: string }

const parseWorkbookIndex = (files: Record<string, Uint8Array>): SheetEntry[] => {
  const wbXml = files["xl/workbook.xml"];
  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (!wbXml || !relsXml) return [];
  const doc = new DOMParser().parseFromString(strFromU8(wbXml), "application/xml");
  const rels = new DOMParser().parseFromString(strFromU8(relsXml), "application/xml");

  // rId → target path (relative to xl/)
  const relMap = new Map<string, string>();
  for (const r of Array.from(rels.getElementsByTagName("Relationship"))) {
    const id = r.getAttribute("Id");
    const target = r.getAttribute("Target");
    if (id && target) relMap.set(id, target);
  }

  const out: SheetEntry[] = [];
  for (const sheet of Array.from(doc.getElementsByTagName("sheet"))) {
    const name = sheet.getAttribute("name") ?? "";
    const rid =
      sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      ?? sheet.getAttribute("r:id");
    if (!rid) continue;
    const target = relMap.get(rid);
    if (!target) continue;
    // Targets in the workbook rels are relative to xl/ — `worksheets/sheet1.xml`.
    out.push({ name, path: target.startsWith("/") ? target.slice(1) : `xl/${target}` });
  }
  return out;
};

// ------------------------------------------------------------------------
// Worksheet parser.
// ------------------------------------------------------------------------

const parseSheet = (
  data: Uint8Array,
  sharedStrings: string[],
): (CellValue | undefined)[][] => {
  const xml = strFromU8(data);
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const rowsXml = doc.getElementsByTagName("row");
  const out: (CellValue | undefined)[][] = [];

  for (const row of Array.from(rowsXml)) {
    const r = parseInt(row.getAttribute("r") ?? "0", 10);
    if (!r) continue;
    const arr: (CellValue | undefined)[] = out[r - 1] ?? [];

    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r"); // e.g. "B5"
      if (!ref) continue;
      const colIdx = colIndex(ref);
      const t = c.getAttribute("t"); // n (default), s, b, str, inlineStr, e
      let value: CellValue | undefined;

      if (t === "s") {
        const v = c.getElementsByTagName("v")[0]?.textContent;
        if (v != null) value = sharedStrings[parseInt(v, 10)];
      } else if (t === "inlineStr") {
        const isEl = c.getElementsByTagName("is")[0];
        if (isEl) {
          let s = "";
          for (const tEl of Array.from(isEl.getElementsByTagName("t"))) {
            s += tEl.textContent ?? "";
          }
          value = s;
        }
      } else if (t === "str") {
        value = c.getElementsByTagName("v")[0]?.textContent ?? "";
      } else if (t === "b") {
        value = c.getElementsByTagName("v")[0]?.textContent === "1";
      } else if (t === "e") {
        // Error cell — surface as the error string, callers can ignore.
        value = c.getElementsByTagName("v")[0]?.textContent ?? "#ERR";
      } else {
        // Default = numeric (incl. dates as serials).
        const v = c.getElementsByTagName("v")[0]?.textContent;
        if (v != null && v !== "") value = Number(v);
      }
      arr[colIdx] = value;
    }
    out[r - 1] = arr;
  }

  // Collapse to a non-sparse outer array (preserves row holes as []).
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
  return out;
};

/** Convert an A1-style column letter sequence to a 0-based index.
 *  "A" → 0, "Z" → 25, "AA" → 26, "AB" → 27, … */
const colIndex = (ref: string): number => {
  let i = 0;
  let n = 0;
  while (i < ref.length) {
    const ch = ref.charCodeAt(i);
    if (ch < 65 || ch > 90) break; // stop at first digit
    n = n * 26 + (ch - 64);
    i++;
  }
  return n - 1;
};
