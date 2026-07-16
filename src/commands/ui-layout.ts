/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError, Option } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { ArkUiDumpAdapter, findNodesInTree } from '../ui/index.js';
import ora from 'ora';
import type { ArkUiNode } from '../ui/index.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';

interface LayoutOptions {
  device?: string;
  id?: string;
  depth: number;
  window?: string;
  allWindows?: boolean;
  format: 'default' | 'json';
  mode: 'full' | 'simplified';
}

function parseNonNegativeInt(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
    throw new InvalidArgumentError('depth must be a non-negative integer');
  }
  return n;
}

function renderNodeLine(node: ArkUiNode): string {
  const parts: string[] = [];
  if (node.type || node.id) {
    parts.push(
      node.type
        ? node.id
          ? `${node.type}#${node.id}`
          : node.type
        : `#${node.id}`
    );
  }
  parts.push(node.bounds ? `[${node.bounds.join(',')}]` : '[]');
  if (node.text) {
    parts.push(`"${JSON.stringify(node.text).slice(1, -1)}"`);
  }
  const flags: string[] = [];
  if (node.clickable) {
    flags.push('clickable');
  }
  if (node.longClickable) {
    flags.push('longClickable');
  }
  if (node.scrollable) {
    flags.push('scrollable');
  }
  if (node.checkable) {
    flags.push('checkable');
  }
  if (flags.length > 0) {
    parts.push(...flags);
  }
  return parts.join(' ');
}

function renderTree(nodes: ArkUiNode[], indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);
  for (const node of nodes) {
    lines.push(`${prefix}${renderNodeLine(node)}`);
    if (node.children.length > 0) {
      lines.push(...renderTree(node.children, indent + 1).split('\n'));
    }
  }
  return lines.join('\n');
}

function validateOptions(options: LayoutOptions) {
  if (options.allWindows && options.window) {
    throw new Error('--all-windows and --window are mutually exclusive.');
  }
}

function outputNodesById(tree: ArkUiNode[], id: string) {
  const nodes = findNodesInTree(tree, id);
  if (nodes.length === 0) {
    throw new Error(`Node '${id}' not found.`);
  }
  const stripped = nodes.map((node) => ({ ...node, children: [] }));
  console.log(JSON.stringify(stripped, null, 2));
}

function outputTree(tree: ArkUiNode[], format: 'default' | 'json') {
  if (format === 'json') {
    console.log(JSON.stringify(tree, null, 2));
  } else {
    console.log(renderTree(tree));
  }
}

async function handleLayoutCommand(options: LayoutOptions) {
  validateOptions(options);
  const spinner = ora({ text: 'Dumping layout…', color: 'cyan' }).start();
  let tree: ArkUiNode[];
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveDeviceSerial(toolProvider, options.device);
    const dumpAdapter = new ArkUiDumpAdapter(toolProvider.hdcPath);
    tree =
      options.mode === 'full'
        ? await dumpAdapter.dumpFullTree(
            serial,
            options.depth,
            options.window,
            options.allWindows
          )
        : await dumpAdapter.dumpCollapsedTree(
            serial,
            options.depth,
            options.window,
            options.allWindows
          );
  } catch (error) {
    spinner.stop();
    throw new Error(`Failed to dump layout: ${(error as Error).message}`, {
      cause: error,
    });
  }
  spinner.stop();

  if (options.id) {
    outputNodesById(tree, options.id);
    return;
  }
  outputTree(tree, options.format);
}

export const layoutCommand = new Command('layout')
  .description('Inspect on-screen node(s) for UI testing')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Layout node id')
  .option('--window <windowId>', 'Target window id')
  .option(
    '--all-windows',
    'Include all windows (mutually exclusive with --window)'
  )
  .addOption(
    new Option(
      '--depth <n>',
      'Tree depth limit (0=unlimited, 1=root only, 2=root+children)'
    )
      .argParser(parseNonNegativeInt)
      .default(0)
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .addOption(
    new Option('--mode <mode>', 'Output mode: full | simplified')
      .choices(['full', 'simplified'])
      .default('simplified')
  )
  .action(async (options: LayoutOptions) => {
    await handleLayoutCommand(options);
  });
