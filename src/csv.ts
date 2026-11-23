/* CSV codec for import/export lanes (influencera Faz 27, TODO 1042/1068).
 * Dependency-free on purpose — no Hono, no Workers, no database — so the
 * same module serves route handlers (parse uploaded text, serialize
 * query results) and scripts. Parsing is RFC-4180 with the tolerances
 * real spreadsheet exports demand: UTF-8 BOM stripped, comma/semicolon
 * delimiter sniffed from the header line, CRLF/LF/CR all end records,
 * blank lines are skipped, and every data row carries its 1-based data
 * index AND physical line number so validators can report "row 7 (line
 * 8): invalid email" instead of a bare string error. Serialization
 * quotes when needed and neutralizes spreadsheet formula injection
 * (=,+,-,@, tab) by default — exports are opened in Excel. */

export type CsvDelimiter = ',' | ';';

/** A parsed data record. `index` counts data rows (header excluded);
 * `line` is the physical line where the record starts — the two differ
 * once a quoted value spans lines. */
export interface CsvRow {
  index: number;
  line: number;
  values: string[];
}

export interface CsvParseOptions {
  /** Comma vs semicolon. Omit to sniff from the header line (majority
   * of unquoted occurrences; ties and no-evidence fall back to comma). */
  delimiter?: CsvDelimiter;
  /** Parse at most this many data rows — the preview step. */
  maxRows?: number;
}

export interface CsvParseResult {
  delimiter: CsvDelimiter;
  /** First non-blank record, cells trimmed. Empty input → []. */
  headers: string[];
  rows: CsvRow[];
  /** True when maxRows stopped the parse with input remaining. */
  truncated: boolean;
}

/** Content type for CSV responses (UTF-8 declared — Excel honors it). */
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

const BOM = '﻿';

function sniffDelimiter(text: string): CsvDelimiter {
  // Only the header line votes, and only occurrences outside quotes —
  // a quoted header cell with a comma must not elect the comma.
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ',') commas += 1;
    else if (!inQuotes && ch === ';') semis += 1;
    else if (!inQuotes && ch === '\n') break;
  }
  return semis > commas ? ';' : ',';
}

/** Parse CSV text. Never throws on shape — ragged rows, stray quotes and
 * unterminated quoting all produce values; STRICTNESS (row length vs
 * headers, field formats, unknown headers) belongs to the caller's
 * validator, which is where row numbers become error messages. */
export function parseCsv(input: string, opts: CsvParseOptions = {}): CsvParseResult {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;

  const records: { line: number; values: string[] }[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false; // a field that had any content or a quote
  let line = 1;
  let recordLine = 1;

  const pushField = () => {
    values.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRecord = () => {
    pushField();
    // Skip blank lines: a record of exactly one empty field that never
    // saw content or quotes. "a,,\n" is three fields and stays.
    if (values.length === 1 && values[0] === '' && !recordHadContent) {
      values = [];
      return;
    }
    records.push({ line: recordLine, values });
    values = [];
  };

  let recordHadContent = false;
  const markContent = () => {
    recordHadContent = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      markContent();
      continue;
    }
    if (ch === delimiter) {
      markContent();
      pushField();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRecord();
      recordHadContent = false;
      recordLine = line + 1;
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      continue;
    }
    if (ch === BOM) continue; // stray mid-file BOM: drop
    markContent();
    fieldStarted = true;
    field += ch;
  }
  // Trailing record without a final newline. An unterminated quote does
  // NOT grow the field — the tolerant read is "field is what
  // accumulated", never a fabricated closing quote.
  if (field !== '' || values.length > 0 || inQuotes) {
    pushRecord();
  }

  const first = records.shift();
  const headers = (first?.values ?? []).map((h) => h.trim());
  const rows: CsvRow[] = [];
  let truncated = false;
  for (let i = 0; i < records.length; i += 1) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const rec = records[i]!;
    rows.push({ index: i + 1, line: rec.line, values: rec.values });
  }
  return { delimiter, headers, rows, truncated };
}

export interface CsvStringifyOptions {
  /** Prepended as the first record when given. */
  header?: string[];
  /** Neutralize spreadsheet formula injection (=, +, -, @, tab) by
   * prefixing a single quote. Default true. A leading minus on a cell
   * that parses as a number is left alone — ledgers export negatives. */
  excelSafe?: boolean;
}

function needsQuote(value: string, delimiter: CsvDelimiter): boolean {
  return (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  );
}

function excelNeutralize(value: string): string {
  const first = value[0];
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
    return `'${value}`;
  }
  if (first === '-' && !Number.isNaN(Number(value.slice(1))) && value.slice(1) !== '') {
    // "-42" is a negative number, not a formula — keep it sortable.
    // But "-1+1|cmd" is not a number and gets the quote.
    return value;
  }
  if (first === '-' && Number.isNaN(Number(value.slice(1)))) {
    return `'${value}`;
  }
  return value;
}

function encodeField(value: string, delimiter: CsvDelimiter, excelSafe: boolean): string {
  const v = excelSafe ? excelNeutralize(value) : value;
  return needsQuote(v, delimiter) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Serialize rows as RFC-4180 CSV: CRLF record separators, quoting only
 * when a field contains the delimiter, a quote or a newline. */
export function stringifyCsv(
  rows: (string | number | null | undefined)[][],
  opts: CsvStringifyOptions = {},
): string {
  const delimiter = ',';
  const excelSafe = opts.excelSafe ?? true;
  const encode = (cell: string | number | null | undefined): string =>
    encodeField(cell === null || cell === undefined ? '' : String(cell), delimiter, excelSafe);
  const lines: string[] = [];
  if (opts.header && opts.header.length > 0) lines.push(opts.header.map(encode).join(delimiter));
  for (const row of rows) lines.push(row.map(encode).join(delimiter));
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}
