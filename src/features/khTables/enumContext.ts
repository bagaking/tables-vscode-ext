import * as path from 'path';
import { promises as fs } from 'fs';
import type { Stats } from 'fs';

export interface EnumOptionPayload {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly source?: 'context' | 'fallback';
}

export interface EnumContextPayload {
  readonly enums: Record<string, readonly EnumOptionPayload[]>;
}

type EnumPrimitive = string | number | boolean;

export interface FileSystemHost {
  stat(targetPath: string): Promise<Stats>;
  readdir(targetPath: string): Promise<string[]>;
  readFile(targetPath: string): Promise<string>;
}

const defaultFsHost: FileSystemHost = {
  stat: (targetPath) => fs.stat(targetPath),
  readdir: (targetPath) => fs.readdir(targetPath),
  readFile: (targetPath) => fs.readFile(targetPath, 'utf8')
};

export const CONTEXT_FILENAME_PATTERN = new RegExp('^context[.].*[.]json$', 'i');
export const CONTEXT_SUBDIRECTORIES = ['context', 'contexts', '.context'];
const BASE_CONTEXT_FILENAME_PATTERN = new RegExp('^context[.][^.]+[.]json$', 'i');

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

function isWithinPathBoundary(target: string, boundary: string): boolean {
  const relative = path.relative(boundary, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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
  if (normalizedWorkspaceRoot && !isWithinPathBoundary(normalizedBase, normalizedWorkspaceRoot)) {
    if (cache) {
      cache.set(normalizedBase, undefined);
    }
    return undefined;
  }

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
    if (normalizedWorkspaceRoot && !isWithinPathBoundary(parent, normalizedWorkspaceRoot)) {
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

export async function loadContextFromDirectory(
  dir: string,
  fileSystem: FileSystemHost = defaultFsHost
): Promise<unknown> {
  const entries = await fileSystem.readdir(dir);
  const context: Record<string, unknown> = {};

  for (const entry of entries.filter(isContextFileName).sort(compareContextFileNames)) {
    const blobName = entry.replace(new RegExp('^context[.]', 'i'), '').replace(new RegExp('[.]json$', 'i'), '').split('.')[0];
    if (!blobName) {
      continue;
    }

    const content = await fileSystem.readFile(path.join(dir, entry));
    const parsed = JSON.parse(content) as unknown;

    if (context[blobName] && isRecord(context[blobName]) && isRecord(parsed)) {
      context[blobName] = { ...context[blobName], ...parsed };
      continue;
    }

    context[blobName] = parsed;
  }

  return context;
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
    const options = contextDefinitionToOptions(definition);

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

function contextDefinitionToOptions(definition: unknown): EnumOptionPayload[] {
  if (Array.isArray(definition)) {
    return definition.flatMap((item, index) => arrayEntryToOptions(item, index));
  }
  if (!isRecord(definition)) {
    return [];
  }

  const options: EnumOptionPayload[] = [];
  for (const [optionKey, rawValue] of Object.entries(definition)) {
    if (optionKey === '__refs' || optionKey === '$refs') {
      continue;
    }
    const option = objectEntryToOption(optionKey, rawValue);
    if (option) {
      options.push(option);
    }
  }
  return options;
}

function objectEntryToOption(optionKey: string, rawValue: unknown): EnumOptionPayload | undefined {
  if (Array.isArray(rawValue)) {
    return optionFromValue(optionKey, rawValue[0], rawValue[1]);
  }
  if (isRecord(rawValue)) {
    if ('ref' in rawValue) {
      return undefined;
    }
    const value = rawValue.value ?? rawValue.literal;
    return optionFromValue(optionKey, value, rawValue.description);
  }
  return optionFromValue(optionKey, rawValue);
}

function arrayEntryToOptions(item: unknown, index: number): EnumOptionPayload[] {
  if (Array.isArray(item)) {
    return compactOption(optionFromValue(deriveLiteralName(item[0], index), item[0], item[1]));
  }
  if (isRecord(item)) {
    if ('ref' in item) {
      return [];
    }
    const value = item.value ?? item.literal;
    const key = typeof item.name === 'string' && item.name ? item.name : deriveLiteralName(value, index);
    return compactOption(optionFromValue(key, value, item.description));
  }
  return compactOption(optionFromValue(deriveLiteralName(item, index), item));
}

function compactOption(option: EnumOptionPayload | undefined): EnumOptionPayload[] {
  return option ? [option] : [];
}

function optionFromValue(
  key: string,
  rawValue: unknown,
  rawDescription?: unknown
): EnumOptionPayload | undefined {
  if (!isEnumPrimitive(rawValue)) {
    return undefined;
  }
  const option: EnumOptionPayload = {
    key,
    value: String(rawValue),
    source: 'context'
  };
  if (rawDescription !== undefined && rawDescription !== null) {
    return { ...option, description: String(rawDescription) };
  }
  return option;
}

function deriveLiteralName(value: unknown, index: number): string {
  if (typeof value === 'number') {
    return `Value${value}`;
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value !== 'string') {
    return `Value${index}`;
  }
  const trimmed = value.trim();
  if (isValidIdentifier(trimmed)) {
    return trimmed;
  }
  const camel = trimmed
    .split(new RegExp('[\\s._-]+'))
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  return camel || `Value${index}`;
}

function isValidIdentifier(value: string): boolean {
  return new RegExp('^[A-Za-z_][A-Za-z0-9_]*$').test(value);
}

function isEnumPrimitive(value: unknown): value is EnumPrimitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isContextFileName(fileName: string): boolean {
  return CONTEXT_FILENAME_PATTERN.test(fileName) && !fileName.startsWith('~');
}

function compareContextFileNames(a: string, b: string): number {
  const rank = (fileName: string) => (BASE_CONTEXT_FILENAME_PATTERN.test(fileName) ? 0 : 1);
  const rankDelta = rank(a) - rank(b);
  return rankDelta === 0 ? a.localeCompare(b) : rankDelta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
