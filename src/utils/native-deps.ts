/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { buildCliDataDirHintLines } from './cli-data-dir.js';
import { getIndexDir } from '../service/doc-index/doc-paths.js';
import {
  assertIndexLexiconReady,
  isLexiconNotFoundError,
} from '../service/doc-index/lexicon.js';
import { getSqliteBackend } from '../service/doc-index/sqlite-backend.js';
import { getJieba } from '../service/doc-index/tokenizer.js';

export class NativeDepsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeDepsError';
  }
}

function buildLexiconMissingHint(): string {
  const indexDir = getIndexDir();
  return [
    'Documentation search index is not installed yet.',
    '',
    ...buildCliDataDirHintLines(),
    `Index directory: ${indexDir}`,
    '',
    'Try:',
    '  1. Wait a moment and run the docs command again (postinstall may still be running)',
    '  2. Reinstall: npm uninstall -g @deveco/deveco-cli && npm install -g <package.tgz>',
  ].join('\n');
}

function buildJiebaInstallHint(): string {
  return [
    'Chinese tokenizer (jieba-wasm) failed to load.',
    '',
    `Node.js: ${process.version} (required: >=18)`,
    '',
    ...buildCliDataDirHintLines(),
    '',
    'Try:',
    '  1. Reinstall: npm uninstall -g @deveco/deveco-cli && npm install -g <package.tgz>',
    '  2. Use Node.js 18 or newer',
  ].join('\n');
}

function buildSqliteErrorMessage(detail: string): string {
  return [detail, '', ...buildCliDataDirHintLines()].join('\n');
}

export async function assertDocNativeDeps(): Promise<void> {
  try {
    assertIndexLexiconReady();
  } catch (error) {
    if (isLexiconNotFoundError(error)) {
      throw new NativeDepsError(`${buildLexiconMissingHint()}\n\nDetail: ${error.message}`);
    }
    throw error;
  }

  try {
    await getJieba();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new NativeDepsError(`${buildJiebaInstallHint()}\n\nDetail: ${detail}`);
  }

  try {
    await getSqliteBackend();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new NativeDepsError(buildSqliteErrorMessage(detail));
  }
}
