/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import lockfile from 'proper-lockfile';
import ora, { type Ora } from 'ora';
import {
  getBundledDocsZipSha256,
  isBuildInProgress,
  isIndexReady,
  needsIndexInstall,
  needsRebuildIndex,
  readBuildMeta,
  readBuildStatus,
  updateBuildStatus,
  writeBuildStatus,
  createInitialStatus,
} from './doc-index/index-state.js';
import {
  installBundledIndex,
  isBundledIndexUsable,
  resetBundledInstallScratch,
} from './doc-index/index-bundle.js';
import {
  findDocsZip,
  getBuildLockFile,
  getDocInitLogPath,
  getIndexDir,
  getIndexTmpDir,
} from './doc-index/doc-paths.js';
import { sha256File } from './doc-index/hash-utils.js';
import {
  buildSearchIndex,
  createTempDocsExtractDir,
  normalizeExtractedLayout,
} from './doc-index/index-builder.js';
import { getSynonymsHash, getTermsHash } from './doc-index/query-rewriter.js';
import { resetSearchDbCache } from './doc-index/sqlite-index.js';
import type { BuildMeta } from './doc-index/segment-types.js';
import { assertDocNativeDeps } from '../utils/native-deps.js';

export class DocNotReadyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DocNotReadyError';
  }
}

export interface DocInitOptions {
  background?: boolean;
  force?: boolean;
  builtBy?: BuildMeta['builtBy'];
  /** Suppress internal ora spinner (awaitDocReady owns UX). */
  quiet?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLog(message: string): Promise<void> {
  const logPath = getDocInitLogPath();
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
  await fs.promises.appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
}

async function extractDocsZipToDir(docsDir: string): Promise<void> {
  const zipPath = findDocsZip();
  if (!zipPath) {
    throw new Error('docs.zip not found');
  }

  await fs.promises.rm(docsDir, { recursive: true, force: true });
  await fs.promises.mkdir(docsDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(docsDir, true);
  await normalizeExtractedLayout(docsDir);
}

async function commitTmpIndex(): Promise<void> {
  const indexDir = getIndexDir();
  const tmpDir = getIndexTmpDir();
  const files = await fs.promises.readdir(tmpDir);

  for (const file of files) {
    const target = path.join(indexDir, file);
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(path.join(tmpDir, file), target);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.rm(path.join(indexDir, 'orama.dpack'), { force: true });
}

async function attemptBundledInstall(
  docsZipSha256: string,
  spinner: Ora | undefined,
  message: string
): Promise<void> {
  spinner?.start(message);
  await updateBuildStatus({
    state: 'installing',
    phase: 1,
    phaseLabel: 'Installing index',
    message,
  });
  await installBundledIndex(docsZipSha256);
  resetSearchDbCache();
  if (spinner) {
    spinner.text = 'Documentation index installed.';
  }
}

/** Tier 1: install bundle. Tier 2: clean scratch and retry. Returns false → local rebuild. */
async function runBundledInstallPath(
  docsZipSha256: string,
  spinner?: Ora
): Promise<boolean> {
  try {
    await attemptBundledInstall(
      docsZipSha256,
      spinner,
      'Installing documentation index…'
    );
    await finalizeSuccess(spinner);
    return true;
  } catch {
    // Tier 2: reset partial install state and re-extract index.zip.
  }

  try {
    await resetBundledInstallScratch();
    resetSearchDbCache();
    await attemptBundledInstall(
      docsZipSha256,
      spinner,
      'Retrying documentation index install…'
    );
    await finalizeSuccess(spinner);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLog(
      `Bundled index install failed; falling back to local rebuild: ${message}`
    );
    return false;
  }
}

async function runLocalIndexBuild(
  options: DocInitOptions,
  docsZipSha256: string,
  spinner?: Ora
): Promise<void> {
  const tmpDir = getIndexTmpDir();
  const docsExtractDir = await createTempDocsExtractDir();
  await fs.promises.mkdir(getIndexDir(), { recursive: true });
  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  spinner?.start('Building search index…');
  await updateBuildStatus({
    state: 'indexing',
    phase: 2,
    phaseLabel: 'Building search index',
    message: 'Building search index…',
  });

  try {
    await extractDocsZipToDir(docsExtractDir);
    await buildSearchIndex({
      docsDir: docsExtractDir,
      tmpDir,
      docsZipSha256,
      termsHash: getTermsHash(),
      synonymsHash: getSynonymsHash(),
      builtBy: options.builtBy ?? 'doc-init',
      onProgress: async (progress) => {
        if (spinner) {
          spinner.text = progress.message;
        }
        await updateBuildStatus({
          state: 'indexing',
          current: progress.current,
          total: progress.total,
          message: progress.message,
        });
      },
    });
  } finally {
    await fs.promises.rm(docsExtractDir, { recursive: true, force: true });
  }

  await updateBuildStatus({
    state: 'persisting',
    phase: 3,
    phaseLabel: 'Persisting index',
    message: 'Persisting index…',
  });
  await commitTmpIndex();
  resetSearchDbCache();
}

async function finalizeSuccess(spinner?: Ora): Promise<void> {
  await updateBuildStatus({
    state: 'done',
    phase: 3,
    phaseLabel: 'Done',
    message: 'Documentation ready.',
    error: null,
  });
  spinner?.succeed('Documentation ready.');
}

async function finalizeUpToDate(spinner?: Ora): Promise<void> {
  const meta = await readBuildMeta();
  const message = meta
    ? `Documentation already up to date. Documents: ${meta.segmentCount.toLocaleString()}`
    : 'Documentation already up to date.';
  spinner?.succeed(message);
  await updateBuildStatus({
    state: 'done',
    message,
    error: null,
  });
}

async function handleInitError(error: unknown, spinner?: Ora): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  await updateBuildStatus({ state: 'error', error: message });
  await appendLog(`ERROR: ${message}`);
  spinner?.fail(message);
  throw error;
}

async function ensureBuildLockFile(): Promise<string> {
  const indexDir = getIndexDir();
  await fs.promises.mkdir(indexDir, { recursive: true });
  const lockPath = getBuildLockFile();
  if (!fs.existsSync(lockPath)) {
    await fs.promises.writeFile(lockPath, '', 'utf-8');
  }
  return lockPath;
}

async function acquireBuildLock(): Promise<() => Promise<void>> {
  const lockPath = await ensureBuildLockFile();
  return lockfile.lock(lockPath, { stale: 30 * 60 * 1000 });
}

async function resolveDocsZipSha256(): Promise<string> {
  const zipPath = findDocsZip();
  const docsZipSha256 =
    (zipPath ? await sha256File(zipPath) : null) ??
    (await getBundledDocsZipSha256());
  if (!docsZipSha256) {
    throw new Error('docs.zip not found');
  }
  return docsZipSha256;
}

async function runInitPipeline(
  options: DocInitOptions,
  spinner?: Ora
): Promise<void> {
  const docsZipSha256 = await resolveDocsZipSha256();
  const shouldInstall = options.force || (await needsIndexInstall(options.force));
  const rebuildReason = await needsRebuildIndex(options.force);

  if (!shouldInstall && !rebuildReason && isIndexReady()) {
    await finalizeUpToDate(spinner);
    return;
  }

  const canUseBundled =
    !options.force && isBundledIndexUsable(docsZipSha256);

  if (canUseBundled && (await runBundledInstallPath(docsZipSha256, spinner))) {
    return;
  }

  await runLocalIndexBuild(options, docsZipSha256, spinner);
  await finalizeSuccess(spinner);
}

export class DocInitializer {
  static async run(options: DocInitOptions = {}): Promise<void> {
    const background = options.background ?? false;
    const quiet = options.quiet ?? background;
    const spinner = quiet
      ? undefined
      : ora({ text: 'Checking documentation…', color: 'cyan' });

    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireBuildLock();
      await writeBuildStatus(createInitialStatus('Starting documentation setup…'));
      await runInitPipeline(options, spinner);
    } catch (error) {
      return handleInitError(error, spinner);
    } finally {
      if (release) {
        await release();
      }
    }
  }
}

async function pollUntilReady(spinner: ReturnType<typeof ora>): Promise<void> {
  while (true) {
    const status = await readBuildStatus();
    if (status.state === 'done' && isIndexReady()) {
      return;
    }
    if (status.state === 'error') {
      throw new DocNotReadyError(
        'build-failed',
        status.error ??
          'Documentation setup failed. Try your docs command again in a moment.'
      );
    }
    spinner.text = status.message || 'Documentation is being prepared…';
    await sleep(500);
  }
}

async function runSetup(spinner: ReturnType<typeof ora>, force = false): Promise<void> {
  spinner.text = force
    ? 'Repairing documentation index…'
    : 'Starting documentation setup…';
  await DocInitializer.run({ builtBy: 'doc-init', force, quiet: true });
}

async function ensureIndexReady(): Promise<void> {
  const rebuildNeeded = (await needsRebuildIndex()) !== null;
  if (isIndexReady() && !rebuildNeeded) {
    return;
  }

  const spinner = ora({
    text: 'Documentation is being prepared…',
    color: 'cyan',
  }).start();

  try {
    if (await isBuildInProgress()) {
      await pollUntilReady(spinner);
      spinner.succeed('Documentation ready.');
      return;
    }

    if (await needsIndexInstall()) {
      await runSetup(spinner);
      spinner.succeed('Documentation ready.');
      return;
    }

    await runSetup(spinner, true);
    spinner.succeed('Documentation ready.');
  } catch (error) {
    spinner.fail((error as Error).message);
    throw error;
  }
}

export async function awaitDocReady(): Promise<void> {
  await ensureIndexReady();
  await assertDocNativeDeps();
}
