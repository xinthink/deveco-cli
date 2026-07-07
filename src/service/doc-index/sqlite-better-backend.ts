/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../doc-portal-types.js';
import type { LocalSearchResult } from '../local-doc-service.js';
import {
  CATALOG_NAME_TO_ID,
  CATALOG_RERANK_POOL_FACTOR,
  INSERT_BATCH_SIZE,
} from './constants.js';
import {
  extractQueryApiSymbolTokens,
  getManagerSplitApiCompound,
  rowMatchesManagerApiModule,
} from './api-identifiers.js';
import {
  inferCatalogBoosts,
  orderRowsWithTailCatalogsLast,
} from './catalog-routing.js';
import { extractSearchSnippet } from './sqlite-snippet.js';
import type { DocumentIndexSource } from './segment-types.js';
import { buildDocumentSearchText, getJieba } from './tokenizer.js';
import type { SqliteBackend } from './sqlite-types.js';

const SCHEMA_SQL = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  catalog_id INTEGER NOT NULL,
  doc_title TEXT NOT NULL
);

CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id),
  section_title TEXT NOT NULL DEFAULT '',
  lead_text TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  search_text,
  content='segments',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
END;

CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
  INSERT INTO segments_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE INDEX segments_doc_id_idx ON segments(doc_id);
`;

interface SearchRow {
  document_id: string;
  doc_title: string;
  section_title: string;
  lead_text: string;
  catalog_id: number;
  bm25: number;
}

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
  db.exec(SCHEMA_SQL);
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
    INSERT INTO segments(doc_id, section_title, lead_text, search_text)
    VALUES (?, ?, ?, ?)
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
          row.searchText
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

const MANAGER_API_RERANK_BOOST = 3.5;
const MANAGER_API_REFERENCE_EXTRA = 1.4;
const TITLE_EXACT_MATCH_BOOST = 4;
const TITLE_PREFIX_MATCH_BOOST = 1.8;
const TITLE_TERMS_MATCH_BOOST = 1.35;
const BROAD_SINGLE_TERM_EXACT_TITLE_BOOST = 3.5;
const BROAD_SINGLE_TERM_PREFIX_TITLE_BOOST = 1.8;
const MIN_RERANK_FETCH_LIMIT = 120;
const TITLE_PREFIX_MIN_CHARS = 6;

function normalizeForRerank(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, '');
}

function splitRerankTerms(rawQuery: string): string[] {
  return rawQuery
    .split(/[^\p{L}\p{N}@.]+/u)
    .map(normalizeForRerank)
    .filter((term) => term.length >= 2);
}

function containsAllTerms(field: string, terms: string[]): boolean {
  return terms.length > 1 && terms.every((term) => field.includes(term));
}

function isBroadSingleAsciiTerm(rawQuery: string): boolean {
  return /^[a-z0-9]{1,4}$/.test(rawQuery.trim().toLowerCase());
}

function broadSingleTermTitleBoost(title: string, term: string): number {
  if (title === term) {
    return BROAD_SINGLE_TERM_EXACT_TITLE_BOOST;
  }
  if (title.startsWith(term) || title.includes(`@ohos.${term}`)) {
    return BROAD_SINGLE_TERM_PREFIX_TITLE_BOOST;
  }
  return 1;
}

function titleMatchBoost(row: SearchRow, rawQuery: string): number {
  const normalizedQuery = normalizeForRerank(rawQuery);
  if (normalizedQuery.length < 2) {
    return 1;
  }

  const title = normalizeForRerank(row.doc_title);
  if (isBroadSingleAsciiTerm(rawQuery)) {
    return broadSingleTermTitleBoost(title, normalizedQuery);
  }

  if (title.includes(normalizedQuery)) {
    return TITLE_EXACT_MATCH_BOOST;
  }
  if (
    normalizedQuery.length >= TITLE_PREFIX_MIN_CHARS &&
    title.includes(normalizedQuery.slice(0, TITLE_PREFIX_MIN_CHARS))
  ) {
    return TITLE_PREFIX_MATCH_BOOST;
  }

  const terms = splitRerankTerms(rawQuery);
  if (containsAllTerms(title, terms)) {
    return TITLE_TERMS_MATCH_BOOST;
  }
  return 1;
}

function applyTitleBoost(score: number, boost: number): number {
  if (boost <= 1) {
    return score;
  }
  return score < 0 ? score * boost : score / boost;
}

function effectiveBm25Score(
  row: SearchRow,
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): number {
  let score = row.bm25 / (boosts.get(row.catalog_id) ?? 1);
  score = applyTitleBoost(score, titleMatchBoost(row, titleQuery));
  if (
    managerCompound &&
    rowMatchesManagerApiModule(row.doc_title, row.section_title, managerCompound)
  ) {
    score /= MANAGER_API_RERANK_BOOST;
    if (row.catalog_id === CATALOG_NAME_TO_ID['harmonyos-references']) {
      score /= MANAGER_API_REFERENCE_EXTRA;
    }
  }
  return score;
}

function minScoreRow(
  rows: SearchRow[],
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): SearchRow {
  return rows.reduce((best, row) =>
    effectiveBm25Score(row, boosts, titleQuery, managerCompound) <
    effectiveBm25Score(best, boosts, titleQuery, managerCompound)
      ? row
      : best
  );
}

function segmentMatchesApiSymbols(
  row: SearchRow,
  apiSymbols: string[]
): boolean {
  return apiSymbols.some(
    (symbol) =>
      row.section_title.includes(symbol) || row.doc_title.includes(symbol)
  );
}

function pickBestSegmentForDocument(
  segments: SearchRow[],
  apiSymbols: string[],
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): SearchRow {
  if (managerCompound) {
    const managerMatches = segments.filter((row) =>
      rowMatchesManagerApiModule(
        row.doc_title,
        row.section_title,
        managerCompound
      )
    );
    if (managerMatches.length > 0) {
      return minScoreRow(managerMatches, boosts, titleQuery, managerCompound);
    }
  }
  if (apiSymbols.length > 0) {
    const titleMatches = segments.filter((row) =>
      segmentMatchesApiSymbols(row, apiSymbols)
    );
    if (titleMatches.length > 0) {
      return minScoreRow(titleMatches, boosts, titleQuery, managerCompound);
    }
  }
  return minScoreRow(segments, boosts, titleQuery, managerCompound);
}

/** One hit per document: keep the section with best (min) catalog-adjusted BM25. */
function collapseToBestSegmentPerDocument(
  rows: SearchRow[],
  rawQuery: string,
  titleQuery: string,
  limit: number,
  deprioritizeTailCatalogs: boolean
): SearchRow[] {
  const boosts = inferCatalogBoosts(rawQuery);
  const apiSymbols = extractQueryApiSymbolTokens(rawQuery);
  const managerSplit = getManagerSplitApiCompound(rawQuery);
  const managerCompound = managerSplit?.camelCase;
  const byDocument = new Map<string, SearchRow[]>();

  for (const row of rows) {
    const segments = byDocument.get(row.document_id) ?? [];
    segments.push(row);
    byDocument.set(row.document_id, segments);
  }

  const representatives: SearchRow[] = [];
  for (const segments of byDocument.values()) {
    representatives.push(
      pickBestSegmentForDocument(
        segments,
        apiSymbols,
        boosts,
        titleQuery,
        managerCompound
      )
    );
  }

  const sorted = representatives.sort(
    (left, right) =>
      effectiveBm25Score(left, boosts, titleQuery, managerCompound) -
      effectiveBm25Score(right, boosts, titleQuery, managerCompound)
  );
  const ordered = deprioritizeTailCatalogs
    ? orderRowsWithTailCatalogsLast(sorted)
    : sorted;
  return ordered.slice(0, limit);
}

function finalizeSearchRows(
  rows: SearchRow[],
  rawQuery: string,
  titleQuery: string,
  limit: number,
  deprioritizeTailCatalogs: boolean
): SearchRow[] {
  return collapseToBestSegmentPerDocument(
    rows,
    rawQuery,
    titleQuery,
    limit,
    deprioritizeTailCatalogs
  );
}

function applyCatalogSoftRerank(
  rows: SearchRow[],
  rawQuery: string,
  titleQuery: string,
  limit: number
): SearchRow[] {
  return finalizeSearchRows(rows, rawQuery, titleQuery, limit, true);
}

const SEARCH_SQL = `
  SELECT d.document_id, d.doc_title, s.section_title, s.lead_text, d.catalog_id,
         bm25(segments_fts) AS bm25
  FROM segments_fts
  JOIN segments s ON s.id = segments_fts.rowid
  JOIN documents d ON d.id = s.doc_id
  WHERE segments_fts MATCH ?
  ORDER BY bm25(segments_fts)
  LIMIT ?
`;

const SEARCH_CATALOG_SQL = `
  SELECT d.document_id, d.doc_title, s.section_title, s.lead_text, d.catalog_id,
         bm25(segments_fts) AS bm25
  FROM segments_fts
  JOIN segments s ON s.id = segments_fts.rowid
  JOIN documents d ON d.id = s.doc_id
  WHERE segments_fts MATCH ? AND d.catalog_id = ?
  ORDER BY bm25(segments_fts)
  LIMIT ?
`;

function searchBetterIndex(
  Database: BetterDatabaseCtor,
  dbPath: string,
  catalog: CatalogName | undefined,
  limit: number,
  match: string,
  query: string,
  rawQuery: string
): LocalSearchResult[] {
  const catalogId = catalog ? CATALOG_NAME_TO_ID[catalog] : undefined;
  const db = openReadonlyDb(Database, dbPath);
  const fetchLimit = Math.max(
    limit,
    limit * CATALOG_RERANK_POOL_FACTOR,
    MIN_RERANK_FETCH_LIMIT
  );

  const rows = (
    catalogId === undefined
      ? db.prepare(SEARCH_SQL)
      : db.prepare(SEARCH_CATALOG_SQL)
  ).all(
    ...(catalogId === undefined ? [match, fetchLimit] : [match, catalogId, fetchLimit])
  ) as SearchRow[];

  const ranked =
    catalogId === undefined
      ? applyCatalogSoftRerank(rows, rawQuery, query, limit)
      : finalizeSearchRows(rows, rawQuery, query, limit, false);

  return ranked.map((row) => ({
    title: row.doc_title,
    documentId: row.document_id,
    sectionTitle: row.section_title || undefined,
    snippet: extractSearchSnippet(row.lead_text, query),
  }));
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
