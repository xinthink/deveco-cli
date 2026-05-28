/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { execa } from 'execa';
import { rgPath } from '@vscode/ripgrep';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import ora from 'ora';
import type { CatalogName } from './doc-portal-types.js';
import { CATALOG_TITLES } from './doc-portal-types.js';

const APP_NAME: string = 'deveco-cli';
const DOCS_DIR_NAME: string = 'docs';

export interface LocalSearchResult {
  title: string;
  documentId: string;
  content: string;
}

export interface LocalDocMetadata {
  title: string;
  version: string;
  anchorList: Array<{ level: string; title: string }>;
}

export class LocalDocService {
  private docsDir: string;
  private versionFile: string;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.docsDir = path.join(
      homedir(),
      '.local',
      'share',
      APP_NAME,
      DOCS_DIR_NAME
    );
    this.versionFile = path.join(this.docsDir, '.version');
  }

  getDocsDir(): string {
    return this.docsDir;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.extractDocsIfNeeded();
    await this.initPromise;
    this.initialized = true;
  }

  private async extractDocsIfNeeded(): Promise<void> {
    const currentVersion = this.getCurrentVersion();
    const existingVersion = await this.getExistingVersion();

    if (existingVersion === currentVersion) {
      return;
    }

    await this.extractDocs(currentVersion);
  }

  private getCurrentVersion(): string {
    return process.env.npm_package_version || '0.0.0';
  }

  private async getExistingVersion(): Promise<string | null> {
    try {
      const version = await fs.promises.readFile(this.versionFile, 'utf-8');
      return version.trim();
    } catch {
      return null;
    }
  }

  private async extractDocs(version: string): Promise<void> {
    const zipPath = this.findDocsZip();
    if (!zipPath) {
      throw new Error('docs.zip not found');
    }

    const spinner = ora({
      text: 'Extracting documentation…',
      color: 'cyan',
    }).start();

    try {
      const parentDir = path.dirname(this.docsDir);
      await fs.promises.mkdir(parentDir, { recursive: true });

      await this.cleanOldDocs();

      await fs.promises.mkdir(this.docsDir, { recursive: true });

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(this.docsDir, true);

      await fs.promises.writeFile(this.versionFile, version, 'utf-8');

      spinner.succeed('Documentation extracted successfully.');
    } catch (error) {
      spinner.fail('Failed to extract documentation.');
      throw error;
    }
  }

  private findDocsZip(): string | null {
    const currentFileUrl = import.meta.url;
    const currentFilePath = fileURLToPath(currentFileUrl);
    const currentDir = path.dirname(currentFilePath);

    const candidates = [
      // 生产环境：代码被打包在 dist/cli.js
      // currentDir 为 dist/，docs.zip 在上一级 (项目根目录)
      path.join(currentDir, '..', 'docs.zip')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async cleanOldDocs(): Promise<void> {
    try {
      await fs.promises.rm(this.docsDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }

  async search(keywords: string[], catalog?: CatalogName): Promise<LocalSearchResult[]> {
    await this.ensureInitialized();

    const searchDir = catalog ? path.join(this.docsDir, CATALOG_TITLES[catalog]) : this.docsDir;
    const fileStats = await this.searchFiles(keywords, searchDir);

    const enriched = await this.enrichWithTitleRelevance(fileStats, keywords);
    const selected = this.selectByTiers(enriched, keywords.length);

    const results = await Promise.all(
      selected.map(async (item) => {
        const relativePath = this.parseFilePath(item.filePath);
        if (!relativePath || !item.metadata) {
          return null;
        }

        const contentPreview = await this.readContentPreview(item.filePath);

        return {
          title: item.metadata.title,
          documentId: relativePath,
          content: contentPreview,
        };
      })
    );

    return results.filter((r): r is LocalSearchResult => r !== null);
  }

  private selectByTiers(
    enriched: Array<{
      filePath: string;
      keywordCount: number;
      totalMatches: number;
      titleKeywordCount: number;
      metadata: LocalDocMetadata | null;
    }>,
    totalKeywords: number
  ): Array<typeof enriched[0]> {
    const byMatches = (a: typeof enriched[0], b: typeof enriched[0]) =>
      b.totalMatches - a.totalMatches;

    const tier1 = enriched
      .filter(i => i.titleKeywordCount === totalKeywords)
      .sort(byMatches);
    const tier2 = enriched
      .filter(i => i.keywordCount === totalKeywords && i.titleKeywordCount < totalKeywords)
      .sort(byMatches);
    const tier3 = enriched
      .filter(i => i.keywordCount < totalKeywords && i.titleKeywordCount < totalKeywords)
      .sort(byMatches);

    return [...tier1, ...tier2, ...tier3];
  }

  private async enrichWithTitleRelevance(
    fileStats: Map<string, { keywordCount: number; totalMatches: number }>,
    keywords: string[]
  ): Promise<Array<{
    filePath: string;
    keywordCount: number;
    totalMatches: number;
    titleKeywordCount: number;
    metadata: LocalDocMetadata | null;
  }>> {
    return Promise.all(
      Array.from(fileStats.entries()).map(async ([filePath, stats]) => {
        const metadata = await this.readMetadata(filePath);
        const titleKeywordCount = metadata
          ? keywords.filter(kw => metadata.title.toLowerCase().includes(kw.toLowerCase())).length
          : 0;
        return {
          filePath,
          keywordCount: stats.keywordCount,
          totalMatches: stats.totalMatches,
          titleKeywordCount,
          metadata,
        };
      })
    );
  }

  private async searchSingleKeyword(
    keyword: string,
    searchDir: string
  ): Promise<Map<string, number>> {
    const rgArgs = ['--type', 'md', '--json', '--no-messages', '-i', '-e', keyword, searchDir];
    const result = await execa(rgPath, rgArgs, { reject: false });

    if (result.exitCode === 1) {
      return new Map();
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr?.trim() || `Search failed with exit code ${result.exitCode}`);
    }

    return this.parseSearchResults(result.stdout);
  }

  private async searchFiles(
    keywords: string[],
    searchDir: string
  ): Promise<Map<string, { keywordCount: number; totalMatches: number }>> {
    const perKeywordResults = await Promise.all(
      keywords.map((kw) => this.searchSingleKeyword(kw, searchDir))
    );

    const fileStats = new Map<string, { keywordCount: number; totalMatches: number }>();
    for (const resultMap of perKeywordResults) {
      for (const [filePath, count] of resultMap) {
        const existing = fileStats.get(filePath);
        if (existing) {
          existing.keywordCount += 1;
          existing.totalMatches += count;
        } else {
          fileStats.set(filePath, { keywordCount: 1, totalMatches: count });
        }
      }
    }

    return fileStats;
  }

  private parseSearchResults(stdout: string): Map<string, number> {
    const lines = stdout.split('\n');
    const fileMatchCounts = new Map<string, number>();

    for (const line of lines) {
      if (!line) {
        continue;
      }
      const match = this.parseSearchResultLine(line);
      if (match) {
        fileMatchCounts.set(match.filePath, match.count);
      }
    }

    return fileMatchCounts;
  }

  private parseSearchResultLine(
    line: string
  ): { filePath: string; count: number } | null {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'end' && parsed.data?.path?.text) {
        const count = parsed.data.stats?.matches ?? 0;
        if (count > 0) {
          return { filePath: parsed.data.path.text, count };
        }
      }
    } catch {
      // skip malformed lines
    }
    return null;
  }

  async readDocument(relativePath: string): Promise<string> {
    await this.ensureInitialized();

    const candidates = [
      path.join(this.docsDir, relativePath),
      path.join(this.docsDir, `${relativePath}.md`),
    ];

    for (const candidate of candidates) {
      try {
        return await fs.promises.readFile(candidate, 'utf-8');
      } catch {
        continue;
      }
    }

    throw new Error(`Document not found: ${relativePath}`);
  }

  private parseFilePath(filePath: string): string | null {
    if (!filePath.endsWith('.md')) {
      return null;
    }

    const relativeToDocs = path.relative(this.docsDir, filePath);
    if (!relativeToDocs || relativeToDocs.startsWith('..')) {
      return null;
    }

    const parts = relativeToDocs.split(/[/\\]/);
    if (parts.length < 2) {
      return null;
    }

    const fileName = parts[parts.length - 1];
    parts[parts.length - 1] = fileName.replace(/\.md$/, '');
    return parts.join('/');
  }

  private async readMetadata(mdFilePath: string): Promise<LocalDocMetadata | null> {
    const jsonFilePath = mdFilePath.replace(/\.md$/, '.json');

    try {
      const content = await fs.promises.readFile(jsonFilePath, 'utf-8');
      return JSON.parse(content) as LocalDocMetadata;
    } catch {
      return null;
    }
  }

  private async readContentPreview(mdFilePath: string): Promise<string> {
    try {
      const fullContent = await fs.promises.readFile(mdFilePath, 'utf-8');
      const preview = fullContent.replace(/\n/g, ' ').trim().slice(0, 200);
      return preview.length < fullContent.replace(/\n/g, ' ').trim().length
        ? preview + '...'
        : preview;
    } catch {
      return '';
    }
  }
}

export const localDocService = new LocalDocService();