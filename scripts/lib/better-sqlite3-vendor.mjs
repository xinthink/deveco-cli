/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { arch, platform } from 'os';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

export const BETTER_SQLITE3_VERSION_LEGACY = '11.10.0';
export const BETTER_SQLITE3_VERSION_MODERN = '12.10.0';
export const BETTER_SQLITE3_VERSION_NODE20 = '12.9.0';
/** @deprecated Use resolveTargetVersion() */
export const BETTER_SQLITE3_VERSION = BETTER_SQLITE3_VERSION_MODERN;

const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com';
const GITHUB_RELEASE_BASE =
  'https://github.com/WiseLibs/better-sqlite3/releases/download';
const PREBUILD_DOWNLOAD_TIMEOUT_MS = 15000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(scriptDir, '..', '..');

export function getRuntimeTriple() {
  return {
    abi: Number(process.versions.modules),
    platform: platform(),
    arch: arch(),
  };
}

export function resolveTargetVersion(nodeVersion = process.version) {
  const major = Number(nodeVersion.slice(1).split('.')[0]);
  if (major < 20) {
    return BETTER_SQLITE3_VERSION_LEGACY;
  }
  // better-sqlite3@12.10.0 removed Node 20/23 prebuilds (ABI 115/131).
  if (major === 20 || major === 23) {
    return BETTER_SQLITE3_VERSION_NODE20;
  }
  return BETTER_SQLITE3_VERSION_MODERN;
}

export function fallbackTargetVersions(primaryVersion) {
  const candidates = [
    primaryVersion,
    BETTER_SQLITE3_VERSION_NODE20,
    BETTER_SQLITE3_VERSION_MODERN,
    BETTER_SQLITE3_VERSION_LEGACY,
  ];
  return [...new Set(candidates)];
}

export function releaseAssetName({ abi, platform: plat, arch: cpu }, version) {
  return `better-sqlite3-v${version}-node-v${abi}-${plat}-${cpu}.tar.gz`;
}

export function resolveNpmRegistry(env = process.env) {
  return (env.npm_config_registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
}

export function releaseDownloadUrls(assetName, version, env = process.env) {
  const registry = resolveNpmRegistry(env);
  const registryBinary = `${registry}/-/binary/better-sqlite3/v${version}/${assetName}`;
  const github = `${GITHUB_RELEASE_BASE}/v${version}/${assetName}`;
  return [...new Set([registryBinary, github])];
}

export async function readInstalledBetterSqlite3Version(packageDir) {
  const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
  return JSON.parse(raw).version;
}

export function tripleKey({ abi, platform: plat, arch: cpu }) {
  return `node-v${abi}-${plat}-${cpu}`;
}

async function findNodeBinary(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'better_sqlite3.node') {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = await findNodeBinary(full);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

export async function extractNodeFromTarGz(tarGzPath, destNodePath) {
  const tmp = await mkdtemp(join(tmpdir(), 'bsqlite-'));
  try {
    const result = spawnSync('tar', ['-xzf', tarGzPath, '-C', tmp], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `tar failed for ${tarGzPath}`);
    }

    const extracted = await findNodeBinary(tmp);
    if (!extracted) {
      throw new Error(`better_sqlite3.node not found inside ${tarGzPath}`);
    }

    await mkdir(dirname(destNodePath), { recursive: true });
    await copyFile(extracted, destNodePath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function resolveBetterSqlite3PackageDir() {
  const { createRequire } = await import('module');
  const require = createRequire(join(packageRoot, 'package.json'));
  try {
    return dirname(require.resolve('better-sqlite3/package.json'));
  } catch {
    return join(packageRoot, 'node_modules', 'better-sqlite3');
  }
}

export function nativeBinaryPath(packageDir) {
  return join(packageDir, 'build', 'Release', 'better_sqlite3.node');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export async function ensurePackageVersion(targetVersion) {
  const packageDir = await resolveBetterSqlite3PackageDir();
  const pkgPath = join(packageDir, 'package.json');

  if (existsSync(pkgPath)) {
    const installed = await readInstalledBetterSqlite3Version(packageDir);
    if (installed === targetVersion) {
      return { ok: true, version: targetVersion, changed: false };
    }
  }

  const result = spawnSync(
    npmCommand(),
    ['install', `better-sqlite3@${targetVersion}`, '--no-save', '--ignore-scripts'],
    {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }
  );

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    return {
      ok: false,
      reason: 'npm-install-failed',
      version: targetVersion,
      error: detail || `exit ${result.status}`,
    };
  }

  const resolvedDir = await resolveBetterSqlite3PackageDir();
  const nativePath = nativeBinaryPath(resolvedDir);
  if (existsSync(nativePath)) {
    await rm(nativePath, { force: true });
  }

  return { ok: true, version: targetVersion, changed: true };
}

export async function downloadPrebuildForTriple(triple, destNodePath, version) {
  const versions = fallbackTargetVersions(version);
  let lastFailure;

  for (const candidateVersion of versions) {
    const result = await downloadPrebuildForTripleOnce(triple, destNodePath, candidateVersion);
    if (result.ok) {
      return result;
    }
    lastFailure = result;
  }

  return lastFailure ?? {
    ok: false,
    reason: 'download-failed',
    triple,
    version,
    error: 'No prebuild available for this Node ABI',
  };
}

async function downloadPrebuildForTripleOnce(triple, destNodePath, version) {
  const asset = releaseAssetName(triple, version);
  const tmp = await mkdtemp(join(tmpdir(), 'bsqlite-dl-'));
  const tarPath = join(tmp, asset);
  let lastError;

  try {
    for (const url of releaseDownloadUrls(asset, version)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          PREBUILD_DOWNLOAD_TIMEOUT_MS
        );
        try {
          const response = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          await writeFile(tarPath, Buffer.from(await response.arrayBuffer()));
        } finally {
          clearTimeout(timeout);
        }
        await extractNodeFromTarGz(tarPath, destNodePath);
        return { ok: true, method: 'download', url, triple, version };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      ok: false,
      reason: 'download-failed',
      triple,
      asset,
      version,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function runPrebuildInstall(packageDir) {
  const requireFromPackage = createRequire(join(packageDir, 'package.json'));
  let prebuildBin;
  try {
    prebuildBin = requireFromPackage.resolve('prebuild-install/bin.js');
  } catch {
    return { ok: false, reason: 'prebuild-install-missing' };
  }

  const result = spawnSync(process.execPath, [prebuildBin], {
    cwd: packageDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: {
      ...process.env,
      npm_config_registry: resolveNpmRegistry(),
    },
  });

  const target = nativeBinaryPath(packageDir);
  if (existsSync(target)) {
    return { ok: true, method: 'prebuild-install', target };
  }

  const stderr = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
  return { ok: false, reason: 'prebuild-install-failed', detail: stderr };
}

export function buildBetterSqlite3InstallInstructions(triple, targetVersion, extra = '') {
  const key = tripleKey(triple);
  const registry = resolveNpmRegistry();

  const lines = [
    'better-sqlite3 native module could not be installed.',
    '',
    `Detected: Node ${process.version} (${triple.platform}-${triple.arch}, ABI ${triple.abi}, key ${key}).`,
    `Target package: better-sqlite3@${targetVersion}. Requires Node.js 18 or newer.`,
    '',
    'Install attempts (in order): npm registry binary → GitHub → prebuild-install.',
    '',
    'Try:',
    '  1. Use Node.js 18 or newer',
    '  2. Set npm registry (also used for better-sqlite3 binary download), then reinstall:',
    '       npm config set registry https://registry.npmmirror.com',
    '       npm uninstall -g @deveco-test/deveco-cli',
    '       npm install -g <path-to>.tgz',
    '  3. If behind a proxy: npm config set https-proxy http://host:port',
  ];
  lines.push('', `Active npm registry: ${registry}`);
  if (extra) {
    lines.push('', `Detail: ${extra}`);
  }
  return lines.join('\n');
}
