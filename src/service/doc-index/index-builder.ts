/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CATALOG_TITLE_TO_ID,
  INDEX_VERSION,
} from './constants.js';
import { buildSqliteSearchIndex } from './sqlite-index.js';
import type { BuildMeta, DocumentIndexSource } from './segment-types.js';
import { buildDocumentIndexSources, resolveDocTitle } from './markdown-splitter.js';
import { copyLexiconFilesToDir, setLexiconDirOverride } from './lexicon.js';

export interface IndexBuildProgress {
  current: number;
  total: number;
  message: string;
}

interface DocMetadata {
  title: string;
}

async function collectMarkdownFiles(docsDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  await walk(docsDir);
  return files;
}

function resolveDocumentMeta(
  mdPath: string,
  docsDir: string
): { documentId: string; catalogId: number; docTitle: string } | null {
  let parts = path.relative(docsDir, mdPath).split(path.sep).join('/').split('/');
  if (parts[0] === 'docs') {
    parts = parts.slice(1);
  }
  if (parts.length < 2) {
    return null;
  }

  const catalogFolder = parts[0];
  const catalogId = CATALOG_TITLE_TO_ID[catalogFolder];
  if (catalogId === undefined) {
    return null;
  }

  const fileName = parts[parts.length - 1].replace(/\.md$/, '');
  parts[parts.length - 1] = fileName;
  return {
    documentId: parts.join('/'),
    catalogId,
    docTitle: fileName,
  };
}

async function readJsonTitle(mdPath: string): Promise<string | undefined> {
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  try {
    const raw = await fs.promises.readFile(jsonPath, 'utf-8');
    const metadata = JSON.parse(raw) as DocMetadata;
    return metadata.title?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function buildDocumentSourcesForFile(
  mdPath: string,
  docsDir: string
): Promise<DocumentIndexSource[]> {
  const meta = resolveDocumentMeta(mdPath, docsDir);
  if (!meta) {
    return [];
  }

  const markdown = await fs.promises.readFile(mdPath, 'utf-8');
  const docTitle = resolveDocTitle(markdown, {
    jsonTitle: await readJsonTitle(mdPath),
    fileName: meta.docTitle,
  });
  return buildDocumentIndexSources(markdown, { ...meta, docTitle });
}

async function insertDocumentsIntoIndex(
  documents: DocumentIndexSource[],
  tmpDir: string,
  onProgress?: (progress: IndexBuildProgress) => Promise<void> | void
): Promise<number> {
  const searchDbPath = path.join(tmpDir, 'search.db');
  await buildSqliteSearchIndex(searchDbPath, documents, async (current, total) => {
    await onProgress?.({
      current,
      total,
      message: `Building search index… ${current.toLocaleString()} / ${total.toLocaleString()} segments`,
    });
  });
  return documents.length;
}

async function collectDocumentSources(docsDir: string): Promise<DocumentIndexSource[]> {
  const mdFiles = await collectMarkdownFiles(docsDir);
  const documents: DocumentIndexSource[] = [];

  for (const mdPath of mdFiles) {
    const sources = await buildDocumentSourcesForFile(mdPath, docsDir);
    documents.push(...sources);
  }

  return documents;
}

function buildIndexMeta(
  options: {
    docsZipSha256: string;
    termsHash: string;
    synonymsHash: string;
    builtBy: BuildMeta['builtBy'];
  },
  segmentCount: number
): BuildMeta {
  return {
    indexVersion: INDEX_VERSION,
    docsZipSha256: options.docsZipSha256,
    termsHash: options.termsHash,
    synonymsHash: options.synonymsHash,
    segmentCount,
    builtAt: Date.now(),
    builtBy: options.builtBy,
  };
}

export async function buildSearchIndex(options: {
  docsDir: string;
  tmpDir: string;
  docsZipSha256: string;
  termsHash: string;
  synonymsHash: string;
  builtBy: BuildMeta['builtBy'];
  lexiconDir?: string;
  onProgress?: (progress: IndexBuildProgress) => Promise<void> | void;
}): Promise<BuildMeta> {
  if (options.lexiconDir) {
    setLexiconDirOverride(options.lexiconDir);
  }

  try {
    const documents = await collectDocumentSources(options.docsDir);

    await options.onProgress?.({
      current: 0,
      total: documents.length,
      message: `Building search index… 0 / ${documents.length.toLocaleString()} segments`,
    });

    await fs.promises.mkdir(options.tmpDir, { recursive: true });
    const total = await insertDocumentsIntoIndex(
      documents,
      options.tmpDir,
      options.onProgress
    );

    const meta = buildIndexMeta(options, total);
    await fs.promises.writeFile(
      path.join(options.tmpDir, 'build-meta.json'),
      JSON.stringify(meta, null, 2)
    );
    await copyLexiconFilesToDir(options.tmpDir);

    return meta;
  } finally {
    if (options.lexiconDir) {
      setLexiconDirOverride(null);
    }
  }
}

export async function createTempDocsExtractDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'deveco-docs-'));
}

async function movePath(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EXDEV') {
      throw error;
    }
    await fs.promises.cp(from, to, { recursive: true });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

export async function normalizeExtractedLayout(docsDir: string): Promise<void> {
  const wrapper = path.join(docsDir, 'docs');
  try {
    await fs.promises.access(wrapper);
  } catch {
    return;
  }

  const skip = new Set(['docs', 'docs.zip']);
  for (const entry of await fs.promises.readdir(wrapper, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const from = path.join(wrapper, entry.name);
    const to = path.join(docsDir, entry.name);
    await fs.promises.rm(to, { recursive: true, force: true });
    await movePath(from, to);
  }

  await fs.promises.rm(path.join(wrapper, 'docs'), { recursive: true, force: true });
  await fs.promises.rm(path.join(wrapper, 'docs.zip'), { force: true });
  await fs.promises.rm(wrapper, { recursive: true, force: true });
}
