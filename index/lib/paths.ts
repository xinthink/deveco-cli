/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const INDEX_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROJECT_ROOT = path.resolve(INDEX_DIR, '..');
export const LEXICON_DIR = path.join(INDEX_DIR, 'data');
export const CACHE_DIR = path.join(PROJECT_ROOT, 'scripts', '.cache');
export const DOCS_ZIP = path.join(PROJECT_ROOT, 'docs.zip');

export function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function candidatePath(name: string): string {
  ensureCacheDir();
  return path.join(CACHE_DIR, name);
}
