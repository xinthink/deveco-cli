/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from './doc-portal-types.js';
import { awaitDocReady } from './doc-initializer.js';
import { readMarkdownFromDocsZip } from './doc-index/docs-zip-reader.js';
import { searchSqliteIndex } from './doc-index/sqlite-index.js';

export interface LocalSearchResult {
  title: string;
  documentId: string;
  snippet: string;
  sectionTitle?: string;
}

export class LocalDocService {
  async search(
    keywords: string[],
    catalog?: CatalogName,
    limit = 20
  ): Promise<LocalSearchResult[]> {
    await awaitDocReady();
    return searchSqliteIndex(keywords, catalog, limit);
  }

  async readDocument(relativePath: string): Promise<string> {
    await awaitDocReady();
    return readMarkdownFromDocsZip(relativePath);
  }
}

export const localDocService = new LocalDocService();
