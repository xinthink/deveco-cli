/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export type {
  CatalogName,
  FlatCatalogNode,
  SearchResult,
} from './portal/catalog.js';
export { CATALOG_NAMES, CATALOG_TITLES } from './portal/catalog.js';

export type { DocInitOptions } from './init/doc-initializer.js';
export {
  DocInitializer,
  DocNotReadyError,
  awaitDocReady,
} from './init/doc-initializer.js';

export type { LocalSearchResult } from './service/local-doc-service.js';
export { localDocService } from './service/local-doc-service.js';

export {
  QUERY_MAX_RAW_CHARS,
  INDEX_DB_MAX_BYTES,
  INDEX_VERSION,
} from './doc-index/constants.js';
export {
  isDocStorageError,
  assertDocStorageSafe,
} from './doc-index/path-safety.js';
export {
  getIndexDir,
  findDocsZip,
  getSearchDbFile,
} from './doc-index/doc-paths.js';
export { sha256File } from './doc-index/hash-utils.js';
export { buildSearchIndex } from './doc-index/index-builder.js';
export { resetSearchDbCache } from './doc-index/sqlite-index.js';
export { getSynonymsHash, getTermsHash } from './doc-index/query-rewriter.js';
export {
  INDEX_LEXICON_FILES,
  assertIndexLexiconReady,
  isLexiconNotFoundError,
} from './doc-index/lexicon.js';
export {
  getSqliteBackend,
  resetSqliteBackendCache,
} from './doc-index/sqlite-backend-cache.js';
export { getJieba } from './doc-index/tokenizer.js';
export { readMarkdownFromDocsZip } from './doc-index/docs-zip-reader.js';
