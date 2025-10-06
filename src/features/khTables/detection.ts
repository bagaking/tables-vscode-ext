import { parse } from 'papaparse';

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

  const preview = parse<string[]>(csvText, {
    dynamicTyping: false,
    skipEmptyLines: false,
    preview: maxRows
  });

  if (!Array.isArray(preview.data)) {
    return { hasMarkers: false, confidence: 0, tokenHits: [] };
  }

  let bestConfidence = 0;
  let bestHits: string[] = [];
  let bestRowIndex: number | undefined;

  preview.data.forEach((row, index) => {
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
