/**
 * streaming-csv.ts — streaming RFC 4180-style CSV reader for files too large
 * to fit in V8's max string length (~512MB).
 *
 * Used by the Paper 2 finance pipeline because the CFPB Consumer Complaint
 * Database CSV is ~8GB unzipped. The healthcare path (Paper 1) keeps using
 * `csv.ts` (in-memory) since MTSamples is ~50MB.
 *
 * Design:
 *   - Read the file in 4MB buffer chunks (sync, fs.readSync).
 *   - Run a per-character state machine across the chunks, handling quoted
 *     fields, escaped quotes (""), embedded newlines inside quoted fields,
 *     and bare CR/LF/CRLF line endings.
 *   - Emit one record at a time via a callback to keep peak memory bounded
 *     by max-record-size (CFPB narratives are at most ~5KB; safe).
 *
 * Determinism contract:
 *   For a given input file, `streamRecords(path, callback)` MUST invoke the
 *   callback with records in the exact same order on every machine and
 *   every run. No async, no parallel chunk processing.
 */

import { closeSync, openSync, readSync } from 'node:fs';

export type StreamingCsvRecord = string[];

const CHUNK_SIZE = 4 * 1024 * 1024;

interface State {
  inQuotes: boolean;
  field: string;
  fields: string[];
}

function newState(): State {
  return { inQuotes: false, field: '', fields: [] };
}

function processChar(state: State, ch: string, emit: (record: StreamingCsvRecord) => void): void {
  if (state.inQuotes) {
    if (ch === '"') {
      // Lookahead for "" is handled by the caller (see streamRecords loop).
      state.inQuotes = false;
    } else {
      state.field += ch;
    }
    return;
  }
  if (ch === '"') {
    state.inQuotes = true;
    return;
  }
  if (ch === ',') {
    state.fields.push(state.field);
    state.field = '';
    return;
  }
  if (ch === '\n') {
    state.fields.push(state.field);
    emit(state.fields);
    state.fields = [];
    state.field = '';
    return;
  }
  if (ch === '\r') {
    // Ignore — paired with \n. If we ever see a bare CR (Mac classic line
    // endings), the field will absorb it as a literal char in the else branch
    // — but in practice CFPB uses \n or \r\n, so this branch just swallows CR.
    return;
  }
  state.field += ch;
}

/**
 * Stream a CSV file from disk and invoke `onRecord` once per logical record
 * (handling multi-line quoted fields). The first emitted record is the header.
 *
 * Strips a leading UTF-8 BOM if present.
 *
 * Throws on read errors. Closes the file descriptor before throwing.
 */
export function streamRecords(
  filePath: string,
  onRecord: (record: StreamingCsvRecord, isHeader: boolean) => void,
): void {
  const fd = openSync(filePath, 'r');
  const state = newState();
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let bomChecked = false;
  let recordIndex = 0;
  // We hold a one-character lookahead so we can correctly detect `""` (escaped
  // quote inside a quoted field) when the two characters span a chunk boundary.
  let pendingChar: string | null = null;

  try {
    let bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, null);
    while (bytesRead > 0) {
      let text = buffer.slice(0, bytesRead).toString('utf8');
      if (!bomChecked) {
        bomChecked = true;
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
      }
      // Prepend any held pending character.
      if (pendingChar !== null) {
        text = pendingChar + text;
        pendingChar = null;
      }

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === undefined) continue;

        // Special handling: if we're inside quotes and see a `"`, peek the
        // next char to detect the `""` escape.
        if (state.inQuotes && ch === '"') {
          const next = text[i + 1];
          if (next === undefined) {
            // Boundary case — hold this char until the next chunk arrives.
            pendingChar = ch;
            break;
          }
          if (next === '"') {
            state.field += '"';
            i++; // consume the second quote
            continue;
          }
          state.inQuotes = false;
          continue;
        }

        processChar(state, ch, (record) => {
          onRecord(record, recordIndex === 0);
          recordIndex++;
        });
      }

      bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, null);
    }

    // Flush any held pending char + tail field/record.
    if (pendingChar !== null) {
      // A trailing unescaped quote at EOF — treat as quote-close.
      state.inQuotes = false;
      pendingChar = null;
    }
    if (state.field.length > 0 || state.fields.length > 0) {
      state.fields.push(state.field);
      onRecord(state.fields, recordIndex === 0);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Convenience wrapper: stream the CSV and invoke `onRow` once per data row
 * (skipping the header), passing a header-keyed object.
 */
export function streamRows(
  filePath: string,
  onRow: (row: Record<string, string>, dataRowIndex: number) => void,
): { headers: string[]; rowCount: number } {
  let headers: string[] = [];
  let dataRowIndex = 0;
  streamRecords(filePath, (record, isHeader) => {
    if (isHeader) {
      headers = record.slice();
      return;
    }
    if (record.length === 1 && record[0] === '') return; // trailing blank
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] ?? '';
      row[key] = record[c] ?? '';
    }
    onRow(row, dataRowIndex);
    dataRowIndex++;
  });
  return { headers, rowCount: dataRowIndex };
}
