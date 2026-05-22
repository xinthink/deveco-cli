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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
    const cliDir = path.dirname(process.argv[1]);
    const candidates = [
      path.join(cliDir, '..', 'docs.zip'),
      path.join(cliDir, 'docs.zip'),
      path.join(process.cwd(), 'docs.zip'),
      path.join(__dirname, '..', '..', 'docs.zip'),
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
    const fileMatchCounts = await this.searchFiles(keywords, searchDir);
    const sortedFiles = Array.from(fileMatchCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([filePath]) => filePath);

    const results = await Promise.all(
      sortedFiles.map(async (filePath) => {
        const relativePath = this.parseFilePath(filePath);
        if (!relativePath) {
          return null;
        }

        const metadata = await this.readMetadata(filePath);
        if (!metadata) {
          return null;
        }

        const contentPreview = await this.readContentPreview(filePath);

        return {
          title: metadata.title,
          documentId: relativePath,
          content: contentPreview,
        };
      })
    );

    return results.filter((r): r is LocalSearchResult => r !== null);
  }

  private async searchFiles(
    keywords: string[],
    searchDir: string
  ): Promise<Map<string, number>> {
    const rgArgs = ['--type', 'md', '--json', '--no-messages'];
    for (const keyword of keywords) {
      rgArgs.push('-e', keyword);
    }
    rgArgs.push(searchDir);

    const result = await execa(rgPath, rgArgs, { reject: false });

    if (result.exitCode === 1) {
      return new Map();
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr?.trim() || `Search failed with exit code ${result.exitCode}`);
    }

    return this.parseSearchResults(result.stdout);
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