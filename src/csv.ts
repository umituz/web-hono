export type CsvDelimiter = ',' | ';';

export interface CsvRow {
  index: number;
  line: number;
  values: string[];
}

export interface CsvParseOptions {
  delimiter?: CsvDelimiter;
  maxRows?: number;
}

export interface CsvParseResult {
  delimiter: CsvDelimiter;
  headers: string[];
  rows: CsvRow[];
  truncated: boolean;
}

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

const BOM = '\uFEFF';

function sniffDelimiter(text: string): CsvDelimiter {
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

export function parseCsv(input: string, opts: CsvParseOptions = {}): CsvParseResult {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;

  const records: { line: number; values: string[] }[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;

  const pushField = () => {
    values.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRecord = () => {
    pushField();
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
    if (ch === BOM) continue;
    markContent();
    fieldStarted = true;
    field += ch;
  }
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
  header?: string[];
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
