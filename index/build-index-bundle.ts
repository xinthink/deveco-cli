/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import {
  buildSearchIndex,
  createTempDocsExtractDir,
  normalizeExtractedLayout,
} from '../src/service/doc-index/index-builder.js';
import { sha256File } from '../src/service/doc-index/hash-utils.js';
import { INDEX_DB_MAX_BYTES } from '../src/service/doc-index/constants.js';
import {
  getSynonymsHash,
  getTermsHash,
} from '../src/service/doc-index/query-rewriter.js';
import { INDEX_LEXICON_FILES } from '../src/service/doc-index/lexicon.js';
import { DOCS_ZIP, LEXICON_DIR, PROJECT_ROOT } from './lib/paths.js';

async function resolveDocsSource(docsZipPath: string): Promise<{ docsExtractDir: string; cleanup: () => Promise<void> }> {
  const docsExtractDir = await createTempDocsExtractDir();

  console.log('Extracting docs.zip to temp dir…');
  const zip = new AdmZip(docsZipPath);
  zip.extractAllTo(docsExtractDir, true);
  await normalizeExtractedLayout(docsExtractDir);

  return {
    docsExtractDir,
    cleanup: async () => {
      await fs.promises.rm(docsExtractDir, { recursive: true, force: true });
    },
  };
}

async function buildAndValidateIndex(
  docsExtractDir: string,
  docsZipSha256: string,
  outputDir: string,
  searchDbPath: string
): Promise<{ segmentCount: number; dbSizeBytes: number }> {
  console.log('Building search.db…');
  const meta = await buildSearchIndex({
    docsDir: docsExtractDir,
    tmpDir: outputDir,
    docsZipSha256,
    termsHash: getTermsHash(LEXICON_DIR),
    synonymsHash: getSynonymsHash(LEXICON_DIR),
    builtBy: 'doc-init',
    lexiconDir: LEXICON_DIR,
    onProgress: (progress) => {
      process.stdout.write(`\r${progress.message}`);
    },
  });
  process.stdout.write('\n');

  const dbStat = await fs.promises.stat(searchDbPath);
  if (dbStat.size > INDEX_DB_MAX_BYTES) {
    throw new Error(
      `search.db is ${(dbStat.size / 1024 / 1024).toFixed(2)} MB, exceeds ${(INDEX_DB_MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit`
    );
  }

  return { segmentCount: meta.segmentCount, dbSizeBytes: dbStat.size };
}

async function packIndexZip(outputDir: string, indexZipPath: string, searchDbPath: string): Promise<number> {
  console.log('Packing index.zip…');
  const bundle = new AdmZip();
  bundle.addLocalFile(searchDbPath);
  bundle.addLocalFile(path.join(outputDir, 'build-meta.json'));
  for (const name of INDEX_LEXICON_FILES) {
    bundle.addLocalFile(path.join(outputDir, name));
  }
  bundle.writeZip(indexZipPath);
  const stat = await fs.promises.stat(indexZipPath);
  return stat.size;
}

async function main(): Promise<void> {
  const docsZipPath = DOCS_ZIP;
  if (!fs.existsSync(docsZipPath)) {
    throw new Error(`docs.zip not found at ${docsZipPath}`);
  }
  const docsZipSha256 = await sha256File(docsZipPath);
  const outputDir = path.join(PROJECT_ROOT, '.index-build');
  const indexZipPath = path.join(PROJECT_ROOT, 'index.zip');
  const searchDbPath = path.join(outputDir, 'search.db');

  const { docsExtractDir, cleanup } = await resolveDocsSource(docsZipPath);

  try {
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

    const { segmentCount, dbSizeBytes } = await buildAndValidateIndex(docsExtractDir, docsZipSha256, outputDir, searchDbPath);
    const indexZipSize = await packIndexZip(outputDir, indexZipPath, searchDbPath);

    console.log(
      `Done. segments=${segmentCount.toLocaleString()}, search.db=${(dbSizeBytes / 1024 / 1024).toFixed(2)} MB, index.zip=${(indexZipSize / 1024 / 1024).toFixed(2)} MB`
    );
  } finally {
    await cleanup();
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
