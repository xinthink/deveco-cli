/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../doc-portal-types.js';
import type { LocalSearchResult } from '../local-doc-service.js';
import type { DocumentIndexSource } from './segment-types.js';

export type SqliteBackendKind = 'better-sqlite3' | 'sqlite-wasm';

export interface SqliteBackend {
  readonly kind: SqliteBackendKind;
  resetCache(): void;
  buildSearchIndex(
    dbPath: string,
    sources: DocumentIndexSource[],
    onProgress?: (current: number, total: number) => Promise<void> | void
  ): Promise<void>;
  searchIndex(
    keywords: string[],
    catalog: CatalogName | undefined,
    limit: number,
    dbPath: string,
    match: string,
    query: string,
    rawQuery: string
  ): Promise<LocalSearchResult[]>;
}
