/**
 * csv.ts — minimal RFC 4180-style CSV parser and emitter.
 *
 * Scope: enough to round-trip the MTSamples dataset and our injected output.
 * NOT a full CSV implementation (no streaming, no exotic encodings).
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0] ?? [];
  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i] ?? [];
    if (record.length === 1 && record[0] === '') continue; // skip trailing blank line
    const row: CsvRow = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] ?? '';
      row[key] = record[c] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cur.push(field);
        field = '';
      } else if (ch === '\n') {
        cur.push(field);
        records.push(cur);
        cur = [];
        field = '';
      } else if (ch === '\r') {
        // ignore; pair with \n
      } else {
        field += ch;
      }
    }
  }
  // Tail field/record.
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    records.push(cur);
  }
  return records;
}

export function emitCsv(headers: readonly string[], rows: ReadonlyArray<CsvRow>): string {
  const parts: string[] = [];
  parts.push(headers.map(escapeField).join(','));
  for (const row of rows) {
    parts.push(headers.map((h) => escapeField(row[h] ?? '')).join(','));
  }
  return parts.join('\n') + '\n';
}

function escapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
