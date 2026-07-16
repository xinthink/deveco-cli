/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { packageRoot } from './better-sqlite3-vendor.mjs';

const JIEBA_WASM_VERSION = '2.0.1';

function resolveNpmCliPath() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function quoteWindowsCmdArg(arg) {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnDetail(result) {
  return [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function runNpmInstallJiebaWasm(targetVersion) {
  const args = [
    'install',
    `@node-rs/jieba-wasm32-wasi@${targetVersion}`,
    '--no-save',
    '--cpu=wasm32',
  ];
  const npmCli = resolveNpmCliPath();
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  }
  if (process.platform === 'win32') {
    const command = ['npm', ...args].map(quoteWindowsCmdArg).join(' ');
    return spawnSync(command, {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: true,
    });
  }
  return spawnSync('npm', args, {
    cwd: packageRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

export async function installJiebaWasmViaNpm(targetVersion = JIEBA_WASM_VERSION) {
  try {
    await import('@node-rs/jieba-wasm32-wasi');
    return { ok: true, skipped: true, reason: 'already-installed' };
  } catch {
    // continue — try native or install wasm
  }

  try {
    await import('@node-rs/jieba');
    return { ok: true, skipped: true, reason: 'native-available' };
  } catch {
    // continue — install wasm fallback
  }

  const result = runNpmInstallJiebaWasm(targetVersion);
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'npm-install-failed',
      version: targetVersion,
      error: spawnDetail(result) || `exit ${result.status ?? 'null'}`,
    };
  }

  try {
    await import('@node-rs/jieba-wasm32-wasi');
  } catch {
    return {
      ok: false,
      reason: 'load-failed',
      version: targetVersion,
      error:
        'npm install finished but @node-rs/jieba-wasm32-wasi still cannot be imported',
    };
  }
  return { ok: true, version: targetVersion, method: 'npm' };
}
