import * as path from 'path';
import { promises as fs } from 'fs';

export interface EnumOptionPayload {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly source?: 'context' | 'fallback';
}

export interface EnumContextPayload {
  readonly enums: Record<string, readonly EnumOptionPayload[]>;
}

export interface FileSystemHost {
  stat(targetPath: string): Promise<fs.Stats>;
  readdir(targetPath: string): Promise<string[]>;
}

const defaultFsHost: FileSystemHost = {
  stat: (targetPath) => fs.stat(targetPath),
  readdir: (targetPath) => fs.readdir(targetPath)
};

export const CONTEXT_FILENAME_PATTERN = /^context\..*\.json$/i;
export const CONTEXT_SUBDIRECTORIES = ['context', 'contexts', '.context'];

export async function hasContextFiles(
  dir: string,
  fileSystem: FileSystemHost = defaultFsHost
): Promise<boolean> {
  try {
    const stats = await fileSystem.stat(dir);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const entries = await fileSystem.readdir(dir);
    return entries.some((entry) => CONTEXT_FILENAME_PATTERN.test(entry));
  } catch {
    return false;
  }
}

async function locateContextInDirectory(
  dir: string,
  fileSystem: FileSystemHost
): Promise<string | undefined> {
  if (await hasContextFiles(dir, fileSystem)) {
    return dir;
  }

  for (const candidate of CONTEXT_SUBDIRECTORIES) {
    const nested = path.join(dir, candidate);
    if (await hasContextFiles(nested, fileSystem)) {
      return nested;
    }
  }

  return undefined;
}

function normalizePath(target: string | undefined): string | undefined {
  return target ? path.resolve(target) : undefined;
}

export async function findContextDirectoryForPath(
  baseDir: string,
  options: {
    workspaceRoot?: string;
    fileSystem?: FileSystemHost;
    cache?: Map<string, string | undefined>;
  } = {}
): Promise<string | undefined> {
  const fileSystem = options.fileSystem ?? defaultFsHost;
  const cache = options.cache;
  const normalizedBase = normalizePath(baseDir);
  if (!normalizedBase) {
    return undefined;
  }

  if (cache && cache.has(normalizedBase)) {
    return cache.get(normalizedBase);
  }

  const normalizedWorkspaceRoot = normalizePath(options.workspaceRoot);
  let currentDir: string | undefined = normalizedBase;
  const visited = new Set<string>();

  while (currentDir) {
    if (visited.has(currentDir)) {
      break;
    }
    visited.add(currentDir);

    const located = await locateContextInDirectory(currentDir, fileSystem);
    if (located) {
      if (cache) {
        cache.set(normalizedBase, located);
      }
      return located;
    }

    if (normalizedWorkspaceRoot && currentDir === normalizedWorkspaceRoot) {
      break;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    if (normalizedWorkspaceRoot && !parent.startsWith(normalizedWorkspaceRoot)) {
      break;
    }
    currentDir = parent;
  }

  if (
    normalizedWorkspaceRoot &&
    !visited.has(normalizedWorkspaceRoot) &&
    normalizedWorkspaceRoot !== normalizedBase
  ) {
    const located = await locateContextInDirectory(normalizedWorkspaceRoot, fileSystem);
    if (located) {
      if (cache) {
        cache.set(normalizedBase, located);
      }
      return located;
    }
  }

  if (cache) {
    cache.set(normalizedBase, undefined);
  }
  return undefined;
}

export function convertContextToEnumPayload(raw: unknown): EnumContextPayload | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const enumsBlob = (raw as { enums?: unknown }).enums;
  if (!enumsBlob || typeof enumsBlob !== 'object') {
    return undefined;
  }

  const result: Record<string, EnumOptionPayload[]> = {};

  for (const [enumName, definition] of Object.entries(enumsBlob as Record<string, unknown>)) {
    if (!definition || typeof definition !== 'object') {
      continue;
    }

    const options: EnumOptionPayload[] = [];
    for (const [optionKey, rawValue] of Object.entries(definition as Record<string, unknown>)) {
      if (rawValue === undefined || rawValue === null) {
        continue;
      }

      let resolvedValue: unknown = rawValue;
      let description: string | undefined;

      if (Array.isArray(rawValue)) {
        resolvedValue = rawValue[0];
        if (rawValue.length > 1 && rawValue[1] != null) {
          description = String(rawValue[1]);
        }
      }

      if (resolvedValue === undefined || resolvedValue === null) {
        continue;
      }

      const valueText = typeof resolvedValue === 'string' ? resolvedValue : String(resolvedValue);
      options.push({ key: optionKey, value: valueText, description, source: 'context' });
    }

    if (options.length > 0) {
      options.sort((a, b) => a.key.localeCompare(b.key));
      result[enumName] = options;
    }
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return { enums: result };
}
