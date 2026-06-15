/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command, InvalidArgumentError } from 'commander';
import { red, dim } from 'colorette';
import { localDocService, LocalSearchResult } from '../service/local-doc-service.js';
import {
  CatalogName,
  CATALOG_NAMES,
  CATALOG_TITLES,
} from '../service/doc-portal-types.js';

interface SearchOptions {
  catalog?: CatalogName | 'all';
  format?: 'json' | 'default';
  limit: number;
}

interface CatalogOptions {
  format?: 'json' | 'default';
}

function validateOneOf<T extends string>(...allowed: T[]): (value: string) => T {
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

const validateSearchFormat = validateOneOf<'json' | 'default'>('json', 'default');
const validateCatalogFormat = validateOneOf<'json' | 'default'>('json', 'default');

const docCommand = new Command('docs').description(
  'Search and read HarmonyOS documentation from local docs directory'
);

docCommand
  .command('search <keywords...>')
  .description('Search documentation by keywords')
  .option('--catalog <name>', 'Catalog name (all : all catalogs)', validateCatalogOrAll, 'all')
  .option('--format <fmt>', 'Output format (default, json)', validateSearchFormat, 'default')
  .option('--limit <n>', 'Max number of results', validatePositiveInt, 20)
  .action(async (keywords: string[], opts: SearchOptions) => {
    try {
      const normalizedKeywords = keywords.map(k => k.trim()).filter(k => k);
      if (normalizedKeywords.length === 0) {
        console.error(red('Keywords cannot be empty.'));
        process.exit(1);
      }
      if (normalizedKeywords.length > 10) {
        console.error(red('Keywords cannot exceed 10.'));
        process.exit(1);
      }

      const catalog = opts.catalog && opts.catalog !== 'all' ? opts.catalog : undefined;
      const results = await localDocService.search(normalizedKeywords, catalog);
      const limitedResults = results.slice(0, opts.limit);

      if (opts.format === 'json') {
        console.log(JSON.stringify(limitedResults, null, 2));
      } else {
        outputSearchResults(limitedResults);
      }
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

docCommand
  .command('read <documentId>')
  .description('Read full content of a document by document ID')
  .action(async (documentId: string) => {
    try {
      const normalizedId = documentId.trim();
      if (!normalizedId) {
        console.error(red('Document ID cannot be empty.'));
        process.exit(1);
      }

      const content = await localDocService.readDocument(normalizedId);
      console.log(content);
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

docCommand
  .command('catalog')
  .description('List all available catalogs')
  .option('--format <fmt>', 'Output format (options: default,json)', validateCatalogFormat, 'default')
  .action((opts: CatalogOptions) => {
    if (opts.format === 'json') {
      const catalogs = CATALOG_NAMES.map(name => ({
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
    if (r.content) {
      console.log(`  Content: ${r.content}`);
    }
    if (i < results.length - 1) {
      console.log();
    }
  }
}

export default docCommand;