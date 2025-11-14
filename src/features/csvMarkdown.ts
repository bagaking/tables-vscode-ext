export function parseCsvToRows(text: string): string[][] {
  // Minimal CSV parser: supports commas, CRLF/LF/CR, quotes with "" escaping; does not skip empty lines
  if (typeof text !== 'string' || text.length === 0) return [[]];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i += 1;
      }
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((v) => (v != null ? String(v) : '')));
}

export function toGfmMarkdown(rows: string[][]): string {
  const pipePattern = new RegExp('\\|', 'g');
  const lineBreakPattern = new RegExp('\\r\\n|\\r|\\n', 'g');
  const safe = (value: string): string => {
    if (value == null) return '';
    // escape pipe, normalize line breaks within a cell
    const text = String(value).replace(pipePattern, '\\|').replace(lineBreakPattern, '<br/>');
    return text;
  };
  const width = rows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);
  const normalized = rows.map((r) => {
    const row = Array.isArray(r) ? r.slice() : [String(r)];
    while (row.length < width) row.push('');
    return row;
  });
  if (normalized.length === 0) {
    return '';
  }
  const header = normalized[0];
  const lines: string[] = [];
  lines.push(`| ${header.map(safe).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (let i = 1; i < normalized.length; i += 1) {
    lines.push(`| ${normalized[i].map(safe).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}
