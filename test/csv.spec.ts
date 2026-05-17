import { describe, expect, it } from 'vitest';

import { emitCsv, parseCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('strips a leading UTF-8 BOM before splitting headers', () => {
    // U+FEFF (﻿) is the byte-order mark Kaggle/Excel exports occasionally
    // prepend. Without explicit stripping, the first header name silently
    // carries the BOM character and downstream column lookups by name fail.
    const text = '﻿h1,h2\nv1,v2\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['h1', 'h2']);
    expect(rows).toEqual([{ h1: 'v1', h2: 'v2' }]);
  });

  it('parses BOM-free input identically', () => {
    const { headers, rows } = parseCsv('h1,h2\nv1,v2\n');
    expect(headers).toEqual(['h1', 'h2']);
    expect(rows).toEqual([{ h1: 'v1', h2: 'v2' }]);
  });

  it('handles quoted fields with commas and embedded newlines', () => {
    const text = 'a,b\n"x,1","y\n2"\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([{ a: 'x,1', b: 'y\n2' }]);
  });

  it('round-trips emitCsv -> parseCsv', () => {
    const headers = ['name', 'note'];
    const rows = [
      { name: 'Alice', note: 'has, comma' },
      { name: 'Bob', note: 'has "quote"' },
    ];
    const emitted = emitCsv(headers, rows);
    const parsed = parseCsv(emitted);
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(rows);
  });
});
