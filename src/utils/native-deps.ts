/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { getSqliteBackend } from '../service/doc-index/sqlite-backend.js';
import { getJieba } from '../service/doc-index/tokenizer.js';

export class NativeDepsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeDepsError';
  }
}

function buildJiebaInstallHint(): string {
  return [
    'Chinese tokenizer (@node-rs/jieba) failed to load.',
    '',
    `Node.js: ${process.version} (required: >=18)`,
    '',
    'Try:',
    '  1. Reinstall: npm uninstall -g @deveco-test/deveco-cli && npm install -g <package.tgz>',
    '  2. Use Node.js 18 or newer',
    '  3. Configure npm registry/proxy if your network blocks optional platform packages',
  ].join('\n');
}

export async function assertDocNativeDeps(): Promise<void> {
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
    throw new NativeDepsError(detail);
  }
}
