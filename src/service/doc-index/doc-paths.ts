/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getCliDataDir } from '../../utils/cli-data-dir.js';

const DOCS_DIR_NAME = 'docs';

export function getDocsDir(): string {
  return path.join(getCliDataDir(), DOCS_DIR_NAME);
}

export function getIndexDir(): string {
  return path.join(getDocsDir(), '.index');
}

export function getBuildLockFile(): string {
  return path.join(getIndexDir(), 'build.lock');
}

export function getBuildStatusFile(): string {
  return path.join(getIndexDir(), 'build-status.json');
}

export function getBuildMetaFile(): string {
  return path.join(getIndexDir(), 'build-meta.json');
}

export function getSearchDbFile(): string {
  return path.join(getIndexDir(), 'search.db');
}

export function getIndexTmpDir(): string {
  return path.join(getIndexDir(), '.tmp');
}

export function getDocInitLogDir(): string {
  return path.join(getCliDataDir(), 'logs');
}

export function getDocInitLogPath(): string {
  return path.join(getDocInitLogDir(), 'doc-init.log');
}

function getDistDir(currentFilePath: string, currentDir: string): string {
  let dir = currentDir;
  while (!dir.endsWith(`${path.sep}dist`) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return dir;
}

function getPackageRootFromDist(currentFilePath: string, currentDir: string): string {
  return path.dirname(getDistDir(currentFilePath, currentDir));
}

export function getPackageRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);

  if (currentFilePath.includes(`${path.sep}dist${path.sep}`)) {
    return getPackageRootFromDist(currentFilePath, currentDir);
  }

  return path.join(currentDir, '..', '..', '..');
}

function resolvePackageRelativePath(...segments: string[]): string[] {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);

  if (currentFilePath.includes(`${path.sep}dist${path.sep}`)) {
    return [path.join(getPackageRootFromDist(currentFilePath, currentDir), ...segments)];
  }

  return [path.join(currentDir, '..', '..', '..', ...segments)];
}

function findBundledAsset(...segments: string[]): string | null {
  for (const candidate of resolvePackageRelativePath(...segments)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findDocsZip(): string | null {
  return findBundledAsset('docs.zip');
}

export function findBundledIndexZip(): string | null {
  return findBundledAsset('index.zip');
}

export function getBuildLexiconDir(): string {
  return path.join(getPackageRoot(), 'index', 'data');
}
