import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import {
  buildSearchIndex,
  createTempDocsExtractDir,
  normalizeExtractedLayout,
} from '../src/service/doc-index/index-builder.js';
import { findDocsZip } from '../src/service/doc-index/doc-paths.js';
import { sha256File } from '../src/service/doc-index/hash-utils.js';
import { INDEX_DB_MAX_BYTES } from '../src/service/doc-index/constants.js';
import {
  getSynonymsHash,
  getTermsHash,
} from '../src/service/doc-index/query-rewriter.js';
import { INDEX_LEXICON_FILES } from '../src/service/doc-index/lexicon.js';
import { LEXICON_DIR, PROJECT_ROOT, resolveDocsDir } from './lib/paths.js';

async function main(): Promise<void> {
  const docsZipPath = findDocsZip() ?? path.join(PROJECT_ROOT, 'docs.zip');
  if (!fs.existsSync(docsZipPath)) {
    throw new Error(`docs.zip not found at ${docsZipPath}`);
  }

  const docsZipSha256 = await sha256File(docsZipPath);
  const localDocsDir = resolveDocsDir();
  const useLocalDocs = Boolean(localDocsDir);
  let docsExtractDir = useLocalDocs ? localDocsDir : await createTempDocsExtractDir();
  const outputDir = path.join(PROJECT_ROOT, '.index-build');
  const indexZipPath = path.join(PROJECT_ROOT, 'index.zip');

  try {
    if (useLocalDocs) {
      console.log(`Using local docs dir: ${localDocsDir}`);
    } else {
      console.log('Extracting docs.zip to temp dir…');
      const zip = new AdmZip(docsZipPath);
      zip.extractAllTo(docsExtractDir, true);
      await normalizeExtractedLayout(docsExtractDir);
    }

    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

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

    const searchDbPath = path.join(outputDir, 'search.db');
    const dbStat = await fs.promises.stat(searchDbPath);
    if (dbStat.size > INDEX_DB_MAX_BYTES) {
      throw new Error(
        `search.db is ${(dbStat.size / 1024 / 1024).toFixed(2)} MB, exceeds ${(INDEX_DB_MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit`
      );
    }

    console.log('Packing index.zip…');
    const bundle = new AdmZip();
    bundle.addLocalFile(searchDbPath);
    bundle.addLocalFile(path.join(outputDir, 'build-meta.json'));
    for (const name of INDEX_LEXICON_FILES) {
      bundle.addLocalFile(path.join(outputDir, name));
    }
    bundle.writeZip(indexZipPath);

    const stat = await fs.promises.stat(indexZipPath);
    console.log(
      `Done. segments=${meta.segmentCount.toLocaleString()}, search.db=${(dbStat.size / 1024 / 1024).toFixed(2)} MB, index.zip=${(stat.size / 1024 / 1024).toFixed(2)} MB`
    );
  } finally {
    if (!useLocalDocs) {
      await fs.promises.rm(docsExtractDir, { recursive: true, force: true });
    }
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
