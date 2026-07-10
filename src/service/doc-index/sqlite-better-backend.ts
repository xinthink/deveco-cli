/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../doc-portal-types.js';
import type { LocalSearchResult } from '../local-doc-service.js';
import { INSERT_BATCH_SIZE } from './constants.js';
import type { DocumentIndexSource } from './segment-types.js';
import { buildDocumentSearchText, getJieba } from './tokenizer.js';
import { runFtsSearch } from './sqlite-fts-search.js';
import { SQLITE_INDEX_SCHEMA_SQL } from './sqlite-schema.js';
import type { SqliteBackend } from './sqlite-types.js';

type BetterDatabase = import('better-sqlite3').Database;
type BetterDatabaseCtor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => BetterDatabase;

let readonlyDb: BetterDatabase | null = null;
let readonlyDbPath: string | null = null;

function resetBetterCache(): void {
  readonlyDb?.close();
  readonlyDb = null;
  readonlyDbPath = null;
}

function openReadonlyDb(Database: BetterDatabaseCtor, dbPath: string): BetterDatabase {
  if (readonlyDb && readonlyDbPath === dbPath) {
    return readonlyDb;
  }

  readonlyDb?.close();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  readonlyDb = db;
  readonlyDbPath = dbPath;
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -8000');
  db.pragma('query_only = ON');
  return db;
}

function openWritableDb(Database: BetterDatabaseCtor, dbPath: string): BetterDatabase {
  const db = new Database(dbPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.exec(SQLITE_INDEX_SCHEMA_SQL);
  return db;
}

function getOrCreateDocId(
  db: BetterDatabase,
  cache: Map<string, number>,
  source: DocumentIndexSource
): number {
  const cached = cache.get(source.documentId);
  if (cached !== undefined) {
    return cached;
  }

  const lookup = db.prepare('SELECT id FROM documents WHERE document_id = ?');
  const existing = lookup.get(source.documentId) as { id: number } | undefined;
  if (existing) {
    cache.set(source.documentId, existing.id);
    return existing.id;
  }

  const insert = db.prepare(`
    INSERT INTO documents(document_id, catalog_id, doc_title)
    VALUES (?, ?, ?)
  `);
  const result = insert.run(source.documentId, source.catalogId, source.docTitle);
  const docId = Number(result.lastInsertRowid);
  cache.set(source.documentId, docId);
  return docId;
}

async function buildBetterIndex(
  Database: BetterDatabaseCtor,
  dbPath: string,
  sources: DocumentIndexSource[],
  onProgress?: (current: number, total: number) => Promise<void> | void
): Promise<void> {
  await getJieba();
  const db = openWritableDb(Database, dbPath);
  const docIdCache = new Map<string, number>();
  const insertSegment = db.prepare(`
    INSERT INTO segments(doc_id, section_title, lead_text, search_text, excerpt_truncated)
    VALUES (?, ?, ?, ?, ?)
  `);

  const total = sources.length;
  for (let i = 0; i < total; i += INSERT_BATCH_SIZE) {
    const batch = sources.slice(i, i + INSERT_BATCH_SIZE);
    const indexedBatch = await Promise.all(
      batch.map(async (source) => ({
        source,
        searchText: await buildDocumentSearchText(source),
      }))
    );

    const writeBatch = db.transaction((rows: typeof indexedBatch) => {
      for (const row of rows) {
        const docId = getOrCreateDocId(db, docIdCache, row.source);
        insertSegment.run(
          docId,
          row.source.sectionTitle,
          row.source.leadText,
          row.searchText,
          row.source.excerptTruncated ? 1 : 0
        );
      }
    });
    writeBatch(indexedBatch);
    await onProgress?.(Math.min(i + batch.length, total), total);
  }

  db.exec('ANALYZE');
  db.exec('VACUUM');
  db.close();
}

function searchBetterIndex(
  Database: BetterDatabaseCtor,
  dbPath: string,
  catalog: CatalogName | undefined,
  limit: number,
  match: string,
  query: string,
  rawQuery: string
): LocalSearchResult[] {
  const db = openReadonlyDb(Database, dbPath);
  return runFtsSearch(
    {
      all<T>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).all(...params) as T[];
      },
    },
    catalog,
    limit,
    match,
    query,
    rawQuery
  );
}

export async function createBetterSqliteBackend(): Promise<SqliteBackend> {
  const module = await import('better-sqlite3');
  const Database = (module as unknown as { default: BetterDatabaseCtor }).default;

  return {
    kind: 'better-sqlite3',
    resetCache: resetBetterCache,
    buildSearchIndex: (dbPath, sources, onProgress) =>
      buildBetterIndex(Database, dbPath, sources, onProgress),
    searchIndex: (_keywords, catalog, limit, dbPath, match, query, rawQuery) =>
      Promise.resolve(
        searchBetterIndex(Database, dbPath, catalog, limit, match, query, rawQuery)
      ),
  };
}
