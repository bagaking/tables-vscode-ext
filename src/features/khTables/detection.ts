/**
 * Lightweight CSV preview parser for extension host (avoid depending on papaparse at runtime).
 * Supports commas, CR/LF, quotes with "" escaping; returns up to maxRows rows.
 */
interface PreviewParseResult {
  readonly rows: string[][];
  readonly hasUnclosedQuotes: boolean;
}

function parsePreview(csvText: string, maxRows: number): PreviewParseResult {
  if (typeof csvText !== 'string' || csvText.length === 0) {
    return { rows: [[]], hasUnclosedQuotes: false };
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < csvText.length && csvText[i + 1] === '"') {
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
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') {
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      if (rows.length >= maxRows) {
        return { rows, hasUnclosedQuotes: inQuotes };
      }
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return { rows: rows.slice(0, maxRows), hasUnclosedQuotes: inQuotes };
}

export interface KhTablesDetection {
  readonly hasMarkers: boolean;
  /** 0-based index of the detected mark row, undefined if not found */
  readonly markRowIndex?: number;
  readonly tokenHits: readonly string[];
  readonly confidence: number;
}

const KNOWN_TOKENS = new Set([
  '@',
  '$ghost',
  '$strict',
  '$oneof',
  'string',
  'int',
  'uint',
  'float',
  'bool',
  'enum',
  'pair',
  'array',
  'map'
]);

const TOKEN_PATTERN = /^(?:@|\$[a-z]+|[a-z]+(?:<[^>]*>)?)$/i;

function countTokenHits(row: readonly string[]): { hits: string[]; confidence: number } {
  let confidence = 0;
  const hits: string[] = [];
  for (const rawCell of row) {
    if (typeof rawCell !== 'string') {
      continue;
    }
    const cell = rawCell.trim();
    if (!cell) {
      continue;
    }

    const fragments = cell.split('|').map((fragment) => fragment.trim()).filter(Boolean);
    if (fragments.length === 0) {
      continue;
    }

    for (const fragment of fragments) {
      const cleaned = fragment.replace(/[?]+$/u, '');
      if (!cleaned) {
        continue;
      }
      const normalized = cleaned.toLowerCase();
      if (KNOWN_TOKENS.has(normalized) || TOKEN_PATTERN.test(cleaned)) {
        hits.push(fragment);
        confidence += normalized === '@' ? 0.4 : 0.22;
        continue;
      }
      if (normalized.startsWith('@') && normalized.length <= 64) {
        // flag scoped primary key fragments such as "@Hero" but ignore long emails
        hits.push(fragment);
        confidence += 0.18;
      }
    }
  }
  return { hits, confidence };
}

export function detectKhTablesMarkers(csvText: string, maxRows = 16): KhTablesDetection {
  if (!csvText || typeof csvText !== 'string') {
    return { hasMarkers: false, confidence: 0, tokenHits: [] };
  }

  const previewData = parsePreview(csvText, maxRows);
  if (previewData.hasUnclosedQuotes) {
    return { hasMarkers: false, confidence: 0, tokenHits: [] };
  }

  let bestConfidence = 0;
  let bestHits: string[] = [];
  let bestRowIndex: number | undefined;

  previewData.rows.forEach((row, index) => {
    if (!Array.isArray(row)) {
      return;
    }
    const { hits, confidence } = countTokenHits(row);
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestHits = hits;
      bestRowIndex = index;
    }
  });

  const hasMarkers = bestConfidence >= 0.6 && bestHits.some((token) => token.trim().startsWith('@'));
  return {
    hasMarkers,
    markRowIndex: hasMarkers ? bestRowIndex : undefined,
    tokenHits: bestHits,
    confidence: bestConfidence
  };
}
