/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as os from 'os';
import * as path from 'path';
import type { EmulatorInfo } from './emulator-types.js';
import { spawnEmulatorDetachedShellWin } from '../utils/emulator-spawn.js';

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

type EmulatorPathSource = {
  value: string;
  startFlag: string;
  hvdFlag: string;
};

function collectEmulatorPathSources(emulator: EmulatorInfo): EmulatorPathSource[] {
  const pathSources: EmulatorPathSource[] = [];
  const parentPath = emulator.instancePath
    ? path.dirname(emulator.instancePath)
    : undefined;
  if (parentPath) {
    pathSources.push({
      value: parentPath,
      startFlag: '-instancePath',
      hvdFlag: '-path',
    });
  }
  if (emulator.instancePath) {
    pathSources.push({
      value: emulator.instancePath,
      startFlag: '-instancePath',
      hvdFlag: '-path',
    });
  }
  if (emulator.path) {
    pathSources.push({
      value: emulator.path,
      startFlag: '-instancePath',
      hvdFlag: '-path',
    });
  }
  return pathSources;
}

function collectEmulatorImageSources(imageRoot: string | undefined): string[][] {
  const imageSources: string[][] = [];
  if (imageRoot) {
    imageSources.push(['-imageRoot', imageRoot]);
  }
  imageSources.push([]);
  return imageSources;
}

/**
 * Order: path-only `-instancePath` (+ `-imageRoot` first when present), then
 * name+path, then uuid / bare name as last resorts — fewer failed launches.
 */
export function buildEmulatorStartArgCandidates(
  listName: string,
  emulator: EmulatorInfo
): string[][] {
  const pathSources = collectEmulatorPathSources(emulator);
  const imageSources = collectEmulatorImageSources(emulator.imageRoot);
  const candidates: string[][] = [];

  for (const imageArgs of imageSources) {
    if (emulator.instancePath) {
      candidates.push([
        '-start',
        '-instancePath',
        emulator.instancePath,
        ...imageArgs,
      ]);
    }
    if (emulator.path && emulator.path !== emulator.instancePath) {
      candidates.push(['-start', '-instancePath', emulator.path, ...imageArgs]);
    }
  }

  for (const { value: pathVal, startFlag, hvdFlag } of pathSources) {
    for (const imageArgs of imageSources) {
      candidates.push([
        '-start',
        listName,
        startFlag,
        pathVal,
        ...imageArgs,
      ]);
      candidates.push(['-hvd', listName, hvdFlag, pathVal, ...imageArgs]);
    }
  }

  const uuid = emulator.uuid?.trim();
  if (uuid) {
    for (const imageArgs of imageSources) {
      candidates.push(['-start', uuid, ...imageArgs]);
      candidates.push(['-hvd', uuid, ...imageArgs]);
    }
  }

  candidates.push(['-start', listName]);
  candidates.push(['-hvd', listName]);

  return dedupeArgLists(candidates);
}

async function tryWindowsShellEmulatorStart(
  emulatorPath: string,
  sdkPath: string,
  listName: string,
  emulator: EmulatorInfo
): Promise<{ ok: true } | { ok: false; lastError: Error }> {
  const attempts = buildEmulatorStartArgCandidates(listName, emulator);
  let lastError = new Error('Windows shell start not attempted');
  for (const argv of attempts) {
    try {
      await spawnEmulatorDetachedShellWin(emulatorPath, sdkPath, argv);
      return { ok: true };
    } catch (err) {
      lastError = err as Error;
    }
  }
  return { ok: false, lastError };
}

export async function runAllEmulatorStartStrategies(
  emulatorPath: string,
  sdkPath: string,
  listName: string,
  targetEmulator: EmulatorInfo,
  executeEmulatorDetached: (args: string[]) => Promise<void>
): Promise<{ ok: true } | { ok: false; lastError: Error }> {
  let lastError: Error = new Error('No start strategy ran');
  const candidates = buildEmulatorStartArgCandidates(
    listName,
    targetEmulator
  );

  const spacedName = /\s/.test(listName);
  const hasInstancePath = Boolean(targetEmulator.instancePath?.trim());
  const shellFirstForSpacedNameOnly =
    os.platform() === 'win32' && spacedName && !hasInstancePath;

  if (shellFirstForSpacedNameOnly) {
    const shellFirst = await tryWindowsShellEmulatorStart(
      emulatorPath,
      sdkPath,
      listName,
      targetEmulator
    );
    if (shellFirst.ok) {
      return { ok: true };
    }
    lastError = shellFirst.lastError;
  }

  for (const args of candidates) {
    try {
      await executeEmulatorDetached(args);
      return { ok: true };
    } catch (err) {
      lastError = err as Error;
    }
  }

  if (os.platform() === 'win32' && !spacedName) {
    const shellOut = await tryWindowsShellEmulatorStart(
      emulatorPath,
      sdkPath,
      listName,
      targetEmulator
    );
    if (shellOut.ok) {
      return { ok: true };
    }
    lastError = shellOut.lastError;
  }

  return { ok: false, lastError };
}
