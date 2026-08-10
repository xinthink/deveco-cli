/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command, InvalidArgumentError } from 'commander';
import { red, dim } from 'colorette';
import { telemetry, EventType, type DocOperation } from '../trace/index.js';
import {
  localDocService,
  type LocalSearchResult,
  awaitDocReady,
  QUERY_MAX_RAW_CHARS,
  isDocStorageError,
  type CatalogName,
  CATALOG_NAMES,
  CATALOG_TITLES,
} from '../docs/index.js';

interface SearchOptions {
  catalog?: CatalogName | 'all';
  format?: 'json' | 'default';
  limit: number;
}

interface CatalogOptions {
  format?: 'json' | 'default';
}

async function trackDocOperation<T>(
  event: DocOperation,
  operation: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await operation();
    await recordDocOperation(event, Date.now() - start, true, null);
    return result;
  } catch (error) {
    const code =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.name)
        : 'UnknownError';
    await recordDocOperation(event, Date.now() - start, false, code);
    throw error;
  }
}

async function recordDocOperation(
  event: DocOperation,
  durationMs: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  await telemetry
    .track(event, {
      duration_ms: durationMs,
      success,
      error_code: errorCode,
    })
    .catch(() => {});
}

function handleDocCommandError(error: unknown): void {
  console.error(red(formatDocCommandError(error)));
  process.exitCode = 1;
}

function validateOneOf<T extends string>(
  ...allowed: T[]
): (value: string) => T {
  return (value: string) => {
    if (!allowed.includes(value as T)) {
      throw new InvalidArgumentError(`Allowed values: ${allowed.join(', ')}`);
    }
    return value as T;
  };
}

function validatePositiveInt(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new InvalidArgumentError('Must be a positive integer.');
  }
  return num;
}

const validateSearchFormat = validateOneOf<'json' | 'default'>(
  'json',
  'default'
);
const validateCatalogFormat = validateOneOf<'json' | 'default'>(
  'json',
  'default'
);

function formatDocCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isDocStorageError(error)) {
    return message;
  }
  if (/\b(EACCES|EPERM|ENOSPC|ENOTDIR|ELOOP)\b/.test(message)) {
    return 'Documentation data directory is unavailable. Check DEVECO_CLI_DATA_DIR and retry.';
  }
  return message;
}

const docCommand = new Command('docs').description(
  'Search and read HarmonyOS documentation from local docs directory'
);

docCommand
  .command('search <keywords...>')
  .description('Search documentation by keywords')
  .option(
    '--catalog <name>',
    'Catalog name (all for all catalogs)',
    validateCatalogOrAll,
    'all'
  )
  .option(
    '--format <fmt>',
    'Output format (default, json)',
    validateSearchFormat,
    'default'
  )
  .option('--limit <n>', 'Max number of results', validatePositiveInt, 10)
  .action(async (keywords: string[], opts: SearchOptions) => {
    const normalizedKeywords = keywords
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'search',
      queryLen: normalizedKeywords.join(' ').length,
      catalog: opts.catalog ?? 'all',
    };
    try {
      await trackDocOperation(event, async () => {
        const searchInput = resolveSearchInput(keywords);
        const catalog =
          opts.catalog && opts.catalog !== 'all' ? opts.catalog : undefined;
        const results = await localDocService.search(
          searchInput,
          catalog,
          opts.limit
        );

        if (opts.format === 'json') {
          console.log(JSON.stringify(results, null, 2));
        } else {
          outputSearchResults(results);
        }
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

docCommand
  .command('read <documentId>')
  .description('Read full content of a document by document ID')
  .action(async (documentId: string) => {
    const normalizedId = documentId.trim();
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'read',
      documentId: normalizedId,
    };
    try {
      await trackDocOperation(event, async () => {
        if (!normalizedId) {
          throw new Error('Document ID cannot be empty.');
        }
        const content = await localDocService.readDocument(normalizedId);
        console.log(content);
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

docCommand
  .command('catalog')
  .description('List all available catalogs')
  .option(
    '--format <fmt>',
    'Output format (default, json)',
    validateCatalogFormat,
    'default'
  )
  .action(async (opts: CatalogOptions) => {
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'catalog',
      fmt: opts.format ?? 'default',
    };
    try {
      await trackDocOperation(event, async () => {
        await awaitDocReady();
        if (opts.format === 'json') {
          const catalogs = CATALOG_NAMES.map((name) => ({
            name,
            title: CATALOG_TITLES[name],
          }));
          console.log(JSON.stringify(catalogs, null, 2));
        } else {
          for (const name of CATALOG_NAMES) {
            console.log(`  ${name.padEnd(20)} ${dim(CATALOG_TITLES[name])}`);
          }
        }
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

function resolveSearchInput(keywords: string[]): string[] {
  const normalizedKeywords = keywords
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  if (normalizedKeywords.length === 0) {
    throw new Error('Keywords cannot be empty.');
  }

  const joined = normalizedKeywords.join(' ');
  if (joined.length > QUERY_MAX_RAW_CHARS) {
    throw new Error(`Query exceeds ${QUERY_MAX_RAW_CHARS} characters.`);
  }
  return normalizedKeywords;
}

function validateCatalogOrAll(value: string): CatalogName | 'all' {
  if (value === 'all') {
    return 'all';
  }
  if (!CATALOG_NAMES.includes(value as CatalogName)) {
    throw new InvalidArgumentError(
      `Invalid catalog "${value}". Allowed: all, ${CATALOG_NAMES.join(', ')}`
    );
  }
  return value as CatalogName;
}

function outputSearchResults(results: LocalSearchResult[]): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(r.documentId);
    console.log(`  Title: ${r.title}`);
    if (r.snippet) {
      console.log(`  Content: ${r.snippet}`);
    }
    if (i < results.length - 1) {
      console.log();
    }
  }
}

export default docCommand;
