// ========================================================================
// Parse helpers — naive CSV + safe JSON.
//
// CSV grammar (RFC 4180-ish subset):
//
//   • Records separated by LF or CRLF. A trailing newline does NOT
//     produce an empty trailing record.
//   • Fields separated by the configured delimiter (default ",").
//   • Fields may be wrapped in double quotes. Inside a quoted field,
//     "" is a literal double quote. Quoted fields may contain delimiters
//     and newlines.
//   • No type coercion — every cell is a string.
//   • No header detection — the first row is just row 0. Hosts that want
//     records-as-objects build that themselves from rows[0].
//   • No comment lines. No skipped blank lines (a blank input line
//     produces a one-element row of "").
//
// This is the convenience helper for simple cases. Real CSV with
// streaming, type inference, locale-aware numbers, BOM stripping,
// configurable line terminators, etc. — bring your own library.
// ========================================================================

export interface ParseCsvOptions {
  /** Field delimiter. Default ",". */
  delimiter?: string;
}

export const parseCsv = (
  text: string,
  opts?: ParseCsvOptions,
): string[][] => {
  const delim = opts?.delimiter ?? ",";
  if (delim.length !== 1) {
    throw new Error(`parseCsv: delimiter must be a single character, got ${JSON.stringify(delim)}`);
  }
  if (delim === '"' || delim === "\n" || delim === "\r") {
    throw new Error(`parseCsv: delimiter cannot be quote, CR, or LF`);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // Lookahead for escaped "" — emit one quote and skip the second.
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // Quote at start of an empty field opens a quoted field. Quote
      // mid-field (rare/malformed) is treated as a literal — matches
      // what most spreadsheet apps do when re-opening their own output.
      if (field === "") {
        inQuotes = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === delim) {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      // CR or CRLF — end the row, swallow LF if present.
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      if (i < n && text[i] === "\n") i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush the trailing field/row only if there's unterminated content.
  // A file ending in a clean newline already pushed its last row above.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
};

// ------------------------------------------------------------------------
// JSON

export type ParseJsonResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export const parseJson = <T = unknown>(text: string): ParseJsonResult<T> => {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
};
