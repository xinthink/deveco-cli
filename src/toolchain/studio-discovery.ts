/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import regedit from 'regedit';
import { debugLog } from '../utils/logger.js';
import { compareStudioVersions, readStudioVersion } from './studio-version.js';

function directories(candidates: string[]): string[] {
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}
function macCandidates(): string[] {
  const result: string[] = [];
  for (const directory of [
    path.join(os.homedir(), 'Applications'),
    '/Applications',
  ]) {
    try {
      result.push(
        ...fs
          .readdirSync(directory)
          .filter(
            (entry) =>
              entry.endsWith('.app') && entry.toLowerCase().includes('deveco')
          )
          .map((entry) => path.join(directory, entry))
      );
    } catch {
      // Application directory is optional.
    }
  }
  return result;
}

type RegistryEntry = {
  keys?: string[];
  values?: Record<string, { value: string }>;
};

function registryList(keys: string[]): Promise<Record<string, RegistryEntry>> {
  return new Promise((resolve, reject) =>
    regedit.list(keys, (error, value) =>
      error ? reject(error) : resolve(value as Record<string, RegistryEntry>)
    )
  );
}

async function registryCandidates(
  root: string,
  includes: (key: string) => boolean,
  valueName: string
): Promise<string[]> {
  const parent = await registryList([root]);
  const keys = (parent[root]?.keys ?? [])
    .filter(includes)
    .map((key) => `${root}\\${key}`);
  if (keys.length === 0) {
    return [];
  }
  const entries = await registryList(keys);
  return keys.flatMap((key) => {
    const value = entries[key]?.values?.[valueName]?.value;
    return value ? [value] : [];
  });
}

async function windowsCandidates(): Promise<string[]> {
  const result = [path.join('C:', 'Program Files', 'Huawei', 'DevEco Studio')];
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    try {
      result.push(
        ...(await registryCandidates(
          root,
          (key) =>
            key
              .normalize('NFKC')
              .trim()
              .toLowerCase()
              .startsWith('deveco studio'),
          'InstallLocation'
        ))
      );
    } catch {
      // Registry keys are optional.
    }
  }
  for (const root of [
    'HKLM\\SOFTWARE\\Huawei\\DevEco Studio',
    'HKLM\\SOFTWARE\\WOW6432Node\\Huawei\\DevEco Studio',
  ]) {
    try {
      result.push(...(await registryCandidates(root, () => true, '')));
    } catch {
      // Registry keys are optional.
    }
  }
  return result;
}

export async function discoverStudioInstallRoot(): Promise<{
  root: string;
  version: string;
}> {
  const platform = os.platform();
  if (platform === 'linux') {
    throw new Error(
      'DevEco Studio is not available on Linux. Set DEVECO_CLI_CLT_PATH to a Command Line Tools installation.'
    );
  }
  const candidates =
    platform === 'darwin' ? macCandidates() : await windowsCandidates();
  const versioned = directories(candidates).flatMap((root) => {
    const version = readStudioVersion(root);
    if (!version) {
      debugLog(`[ToolProvider] Skipping ${root}: could not read version`);
      return [];
    }
    debugLog(`[ToolProvider] ${root} => version ${version}`);
    return [{ root, version }];
  });
  if (!versioned.length) {
    throw new Error(
      'DevEco Studio installation not found in default locations. Set DEVECO_CLI_STUDIO_PATH to a DevEco Studio installation, or set DEVECO_CLI_CLT_PATH to a Command Line Tools installation.'
    );
  }
  return versioned.reduce((best, current) =>
    compareStudioVersions(current.version, best.version) > 0 ? current : best
  );
}
