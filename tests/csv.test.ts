import { describe, expect, it } from 'vitest';
import { CSV_CONTENT_TYPE, parseCsv, stringifyCsv } from '../src/csv';

/* CSV codec unit family (influencera Faz 27, TODO 1042/1068): the parser
 * is the front door of every bulk import and the serializer the back door
 * of every export — BOM/delimiter tolerance, RFC-4180 quoting, row/line
 * bookkeeping and formula-injection neutralization all live here. */

describe('parseCsv tolerances', () => {
  it('strips a UTF-8 BOM before reading the header', () => {
    const res = parseCsv('﻿name,email\nAda,ada@x.dev');
    expect(res.headers).toEqual(['name', 'email']);
    expect(res.rows[0]!.values).toEqual(['Ada', 'ada@x.dev']);
  });

  it('sniffs a semicolon majority from the header line', () => {
    const res = parseCsv('name;email;notes\nAda;ada@x.dev;hi');
    expect(res.delimiter).toBe(';');
    expect(res.rows[0]!.values).toEqual(['Ada', 'ada@x.dev', 'hi']);
  });

  it('comma wins ties and no-evidence lines', () => {
    expect(parseCsv('a;b\n1;2').delimiter).toBe(';');
    expect(parseCsv('a;b,c\n1').delimiter).toBe(',');
    expect(parseCsv('name\nAda').delimiter).toBe(',');
    expect(parseCsv('').delimiter).toBe(',');
  });

  it('a quoted comma in the header does not vote for the comma', () => {
    const res = parseCsv('"a,b";c\n1;2');
    expect(res.delimiter).toBe(';');
    expect(res.headers).toEqual(['a,b', 'c']);
  });

  it('honors a forced delimiter over the sniff', () => {
    const res = parseCsv('a;b\nc;d', { delimiter: ';' });
    expect(res.delimiter).toBe(';');
    expect(res.rows[0]!.values).toEqual(['c', 'd']);
  });

  it('quoted fields keep commas, escaped quotes and newlines', () => {
    const res = parseCsv('name,notes\n"Ada, B.","said ""hi""\nthen left"');
    expect(res.rows[0]!.values).toEqual(['Ada, B.', 'said "hi"\nthen left']);
    // The quoted value spanned a physical line — the NEXT row's line
    // number must still be right.
    expect(res.rows[0]!.line).toBe(2);
  });

  it('row.line tracks physical lines across multi-line quoted values', () => {
    const res = parseCsv('a,b\n"x\ny\nz",2\n3,4');
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]!.line).toBe(2);
    expect(res.rows[1]!.line).toBe(5);
    expect(res.rows[1]!.values).toEqual(['3', '4']);
  });

  it('skips blank lines anywhere in the file', () => {
    const res = parseCsv('a,b\n\n1,2\n\n\n3,4\n');
    expect(res.rows.map((r) => r.values)).toEqual([['1', '2'], ['3', '4']]);
    expect(res.rows[1]!.index).toBe(2);
  });

  it('accepts CRLF, LF and lone CR record ends', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows[0]!.values).toEqual(['1', '2']);
    expect(parseCsv('a,b\n1,2\n').rows[0]!.values).toEqual(['1', '2']);
    expect(parseCsv('a,b\r1,2\r').rows[0]!.values).toEqual(['1', '2']);
  });

  it('trims header cells but leaves data values untouched', () => {
    const res = parseCsv('  name , email \n  Ada , x ');
    expect(res.headers).toEqual(['name', 'email']);
    expect(res.rows[0]!.values).toEqual(['  Ada ', ' x ']);
  });

  it('preserves ragged rows for the validator to flag', () => {
    const res = parseCsv('a,b,c\n1,2,3\n4,5');
    expect(res.rows[1]!.values).toEqual(['4', '5']);
  });

  it('treats a quote inside an unquoted field as literal', () => {
    const res = parseCsv('a,b\n5"4,1');
    expect(res.rows[0]!.values).toEqual(['5"4', '1']);
  });

  it('closes an unterminated quote at EOF instead of hanging a record', () => {
    const res = parseCsv('a,b\n"open,1');
    expect(res.rows[0]!.values).toEqual(['open,1']);
  });
});

describe('parseCsv preview', () => {
  it('maxRows stops early and reports truncation', () => {
    const res = parseCsv('a,b\n1,2\n3,4\n5,6', { maxRows: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('truncated stays false when maxRows covers everything', () => {
    const res = parseCsv('a,b\n1,2', { maxRows: 5 });
    expect(res.truncated).toBe(false);
  });
});

describe('parseCsv empty shapes', () => {
  it('empty input yields no headers and no rows', () => {
    const res = parseCsv('');
    expect(res.headers).toEqual([]);
    expect(res.rows).toEqual([]);
  });

  it('a header-only file yields headers and no data rows', () => {
    const res = parseCsv('a,b\n');
    expect(res.headers).toEqual(['a', 'b']);
    expect(res.rows).toEqual([]);
  });
});

describe('stringifyCsv', () => {
  it('emits clean fields unquoted with CRLF separators', () => {
    expect(stringifyCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });

  it('prepends the header row when given', () => {
    expect(stringifyCsv([['1']], { header: ['a'] })).toBe('a\r\n1\r\n');
  });

  it('quotes fields with delimiter, quote or newline; escapes quotes', () => {
    expect(stringifyCsv([['a,b', 'say "hi"', 'l1\nl2']])).toBe(
      '"a,b","say ""hi""","l1\nl2"\r\n',
    );
  });

  it('renders null/undefined/numbers without ceremony', () => {
    expect(stringifyCsv([[null, undefined, 42, 1.5]])).toBe(',,42,1.5\r\n');
  });

  it('empty rows array produces empty output', () => {
    expect(stringifyCsv([])).toBe('');
  });
});

describe('stringifyCsv excel safety', () => {
  it('neutralizes formula leads =, +, @ and tab with a quote prefix', () => {
    expect(stringifyCsv([['=1+1', '@SUM(A1)', '+1', '\t9']])).toBe(
      "'=1+1,'@SUM(A1),'+1,'\t9\r\n",
    );
  });

  it('keeps negative numbers raw but quotes minus-led non-numbers', () => {
    expect(stringifyCsv([['-42', '-2+3|cmd']])).toBe("-42,'-2+3|cmd\r\n");
  });

  it('excelSafe: false leaves everything raw', () => {
    expect(stringifyCsv([['=1+1']], { excelSafe: false })).toBe('=1+1\r\n');
  });

  it('content type declares UTF-8 for Excel', () => {
    expect(CSV_CONTENT_TYPE).toBe('text/csv; charset=utf-8');
  });
});
