/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as path from 'path';
import { existsSync, statSync } from 'fs';
import type { EmulatorInfo } from './emulator-types.js';

function pickStringField(
  item: Record<string, unknown>,
  keys: string[]
): string {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return '';
}

function pickInstancePathFromListItem(item: Record<string, unknown>): string {
  const direct = pickStringField(item, [
    'instancePath',
    'instance_path',
    'InstancePath',
    'instancepath',
    'instanceDir',
    'instance_dir',
    'InstanceDir',
    'deployPath',
    'deploy_path',
    'deployedPath',
    'deployed_path',
    'workPath',
    'work_path',
    'dataPath',
    'data_path',
  ]);
  if (direct) {
    return direct;
  }
  for (const [k, v] of Object.entries(item)) {
    if (typeof v !== 'string' || !v.trim()) {
      continue;
    }
    const lk = k.toLowerCase();
    if (
      (lk.includes('instance') &&
        (lk.includes('path') || lk.includes('dir'))) ||
      lk === 'deployedpath'
    ) {
      return v.trim();
    }
  }
  return '';
}

function pickUuidFromListItem(item: Record<string, unknown>): string {
  return pickStringField(item, [
    'uuid',
    'UUID',
    'Uuid',
    'instanceUuid',
    'instance_uuid',
    'InstanceUuid',
  ]);
}

/**
 * Some `-list -details` rows omit `instancePath` while the deployed folder exists
 * beside other instances (same parent as e.g. .../deployed/Huawei_WideFold).
 */
function hydrateMissingInstancePaths(emulators: EmulatorInfo[]): void {
  const anchor = emulators.find((e) => e.instancePath?.trim());
  if (!anchor?.instancePath?.trim()) {
    return;
  }
  const deployRoot = path.dirname(path.normalize(anchor.instancePath));
  for (const e of emulators) {
    if (e.instancePath?.trim()) {
      continue;
    }
    const candidate = path.join(deployRoot, e.name);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      e.instancePath = candidate.replace(/\\/g, '/');
    }
  }
}

function tryParseListJson(output: string): EmulatorInfo[] | null {
  try {
    const jsonOutput = JSON.parse(output);
    if (!Array.isArray(jsonOutput)) {
      return null;
    }
    return jsonOutput
      .map((item: Record<string, unknown>) => {
        const uuid = pickUuidFromListItem(item);
        return {
          name: (item.name || item.Name || '') as string,
          isRunning:
            item.isRunning === true ||
            String(item.isRunning).toLowerCase() === 'true',
          instancePath: pickInstancePathFromListItem(item),
          path: pickStringField(item, ['path', 'Path', 'hvdPath', 'hvd_path']),
          imageRoot: pickStringField(item, [
            'imageRoot',
            'image_root',
            'ImageRoot',
          ]),
          uuid: uuid || undefined,
        };
      })
      .filter((emu: EmulatorInfo) => emu.name);
  } catch {
    return null;
  }
}

function parseListText(output: string): EmulatorInfo[] {
  const emulators: EmulatorInfo[] = [];
  const fieldRegex =
    /^(name|isrunning|instancepath|path|imageroot)\s*:\s*(.+)/gim;

  let current: EmulatorInfo | null = null;
  let match;

  while ((match = fieldRegex.exec(output)) !== null) {
    const [, key, value] = match;
    if (key.toLowerCase() === 'name') {
      if (current) {
        emulators.push(current);
      }
      current = { name: value.trim() };
    } else if (current) {
      const k = key.toLowerCase();
      if (k === 'isrunning') {
        current.isRunning = value.trim().toLowerCase() === 'true';
      } else if (k === 'instancepath') {
        current.instancePath = value.trim();
      } else if (k === 'path') {
        current.path = value.trim();
      } else if (k === 'imageroot') {
        current.imageRoot = value.trim();
      }
    }
  }

  if (current) {
    emulators.push(current);
  }
  return emulators;
}

export function parseEmulatorListOutput(output: string): EmulatorInfo[] {
  const fromJson = tryParseListJson(output);
  const list = fromJson ?? parseListText(output);
  hydrateMissingInstancePaths(list);
  return list;
}
