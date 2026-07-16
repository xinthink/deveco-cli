/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ToolProvider } from '../../toolchain/tool-provider.js';
import { resolveDeviceSerial } from '../../utils/device-selector.js';
import { ArkUiDumpAdapter } from '../layout/dump-adapter.js';
import { findNodesInTree } from '../layout/parsers.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';

export async function initDevice(deviceArg?: string) {
  const toolProvider = await ToolProvider.new();
  const deviceId = await resolveDeviceSerial(toolProvider, deviceArg);
  return { hdcPath: toolProvider.hdcPath, deviceId };
}

export async function resolveTarget(
  hdcPath: string,
  deviceId: string,
  x: number | undefined,
  y: number | undefined,
  nodeId: string | undefined,
  windowId: string | undefined
): Promise<{ x: number; y: number }> {
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  const adapter = new ArkUiDumpAdapter(hdcPath);
  const tree = await adapter.dumpFullTree(deviceId, 0, windowId, !windowId);
  const matched = findNodesInTree(tree, nodeId!);
  if (matched.length === 0) {
    throw new Error(`Node "${nodeId}" not found.`);
  }
  if (matched.length > 1) {
    throw new Error(`Multiple nodes found with id "${nodeId}".`);
  }
  const nodeBounds = matched[0].bounds;
  if (!nodeBounds) {
    throw new Error(`Node "${nodeId}" not found.`);
  }
  const [left, top, right, bottom] = nodeBounds;
  return {
    x: Math.ceil((left + right) / 2),
    y: Math.ceil((top + bottom) / 2),
  };
}

export async function runHdcShell(
  hdcPath: string,
  deviceId: string,
  shellArgs: string[]
): Promise<void> {
  const args = ['-t', deviceId, 'shell', ...shellArgs];
  const result = await runHdcWithRetry(hdcPath, args);

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        `uitest exited with code ${result.exitCode}`
    );
  }

  const lower = result.stdout.toLowerCase();
  const failKeywords = [
    'illegal',
    'fail',
    'error',
    'incorrect',
    'please confirm that the coordinate values are correct',
  ];
  if (
    failKeywords.some((k) => lower.includes(k)) &&
    !lower.includes('no error')
  ) {
    throw new Error(result.stdout.trim() || 'uitest command failed');
  }
}
