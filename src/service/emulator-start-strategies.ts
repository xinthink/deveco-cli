/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as path from 'path';
import type { EmulatorInfo } from './emulator-types.js';

type EmulatorNativeBootMode = 'snapshot';

function dedupeArgLists(lists: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const args of lists) {
    const k = JSON.stringify(args);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(args);
  }
  return out;
}

/** Parent of the instance folder (e.g. .../deployed for .../deployed/AAA). */
function resolveEmulatorDeployedParentDir(emulator: EmulatorInfo): string {
  const ip = emulator.instancePath?.trim();
  if (ip) {
    return path.dirname(path.normalize(ip)).replace(/\\/g, '/');
  }
  const p = emulator.path?.trim();
  if (p) {
    return path.dirname(path.normalize(p)).replace(/\\/g, '/');
  }
  return '';
}

function collectEmulatorImageSources(
  imageRoot: string | undefined
): string[][] {
  const imageSources: string[][] = [];
  if (imageRoot) {
    imageSources.push(['-imageRoot', imageRoot]);
  }
  imageSources.push([]);
  return imageSources;
}

function withBootMode(
  args: string[],
  nativeBootMode?: EmulatorNativeBootMode
): string[] {
  if (!nativeBootMode) {
    return args;
  }
  return [...args, '-bootmode', nativeBootMode];
}

/**
 * Prefer bare `-start <name>`; fall back to `-hvd <name> -path <deployedParent>
 * [-imageRoot …] [-bootmode …]` when list details supply paths.
 */
export function buildEmulatorStartArgCandidates(
  listName: string,
  emulator: EmulatorInfo,
  nativeBootMode?: EmulatorNativeBootMode
): string[][] {
  const candidates: string[][] = [
    withBootMode(['-start', listName], nativeBootMode),
  ];

  const pathVal = resolveEmulatorDeployedParentDir(emulator);
  if (pathVal) {
    for (const imageArgs of collectEmulatorImageSources(emulator.imageRoot)) {
      candidates.push(
        withBootMode(
          ['-hvd', listName, '-path', pathVal, ...imageArgs],
          nativeBootMode
        )
      );
    }
  }

  return dedupeArgLists(candidates);
}

export async function runAllEmulatorStartStrategies(
  listName: string,
  targetEmulator: EmulatorInfo,
  executeEmulatorDetached: (args: string[]) => Promise<void>,
  nativeBootMode?: EmulatorNativeBootMode
): Promise<{ ok: true } | { ok: false; lastError: Error }> {
  let lastError: Error = new Error('No start strategy ran');
  const candidates = buildEmulatorStartArgCandidates(
    listName,
    targetEmulator,
    nativeBootMode
  );

  for (const args of candidates) {
    try {
      await executeEmulatorDetached(args);
      return { ok: true };
    } catch (err) {
      lastError = err as Error;
    }
  }

  return { ok: false, lastError };
}
