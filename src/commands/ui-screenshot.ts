/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { green, red } from 'colorette';
import { DeviceManager } from '../service/device-manager.js';
import { ToolProvider } from '../utils/tool-provider.js';
import { debugLog } from '../utils/logger.js';

interface ScreenshotOptions {
  device?: string;
  display?: string;
  path?: string;
}

interface ScreenshotContext {
  hdcPath: string;
  serial: string;
  localPath: string;
  remotePath: string;
  display?: string;
}

interface HdcResult {
  stdout: string;
  stderr: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveLocalPath(input: string | undefined): string {
  if (!input?.trim()) {
    return path.resolve(`screenshot-${timestamp()}.png`);
  }
  const resolved = path.resolve(input.trim());
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, `screenshot-${timestamp()}.png`);
  }
  if (path.extname(resolved).toLowerCase() !== '.png') {
    if (!fs.existsSync(resolved)) {
      throw new Error(`Screenshot directory does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Screenshot path is not a directory: ${resolved}`);
    }
    return path.join(resolved, `screenshot-${timestamp()}.png`);
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`Screenshot directory does not exist: ${parent}`);
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error(`Screenshot parent path is not a directory: ${parent}`);
  }
  return resolved;
}

function assertPngFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Screenshot file was not created: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Screenshot file is empty: ${filePath}`);
  }
  const signature = fs.readFileSync(filePath).subarray(0, 8);
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!signature.equals(pngSignature)) {
    throw new Error(`Screenshot file is not a valid PNG: ${filePath}`);
  }
}

async function runHdc(
  hdcPath: string,
  args: string[],
  cwd?: string
): Promise<string> {
  debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
  const { stdout } = await execa(hdcPath, args, {
    env: { ...process.env },
    cwd,
  });
  return stdout;
}

async function runHdcResult(
  hdcPath: string,
  args: string[],
  cwd?: string
): Promise<HdcResult> {
  debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
  const { stdout, stderr } = await execa(hdcPath, args, {
    env: { ...process.env },
    cwd,
  });
  return { stdout, stderr };
}

async function tryRunHdc(
  hdcPath: string,
  args: string[],
  cwd?: string
): Promise<string> {
  try {
    return await runHdc(hdcPath, args, cwd);
  } catch (error) {
    return (error as { stdout?: string; stderr?: string }).stdout ?? '';
  }
}

async function resolveTargetSerial(
  toolProvider: ToolProvider,
  selector: string | undefined
): Promise<string> {
  const manager = DeviceManager.from(toolProvider);
  const devices = await manager.listDevices();
  if (devices.length === 0) {
    throw new Error(
      'No active devices found. Start an emulator or connect a physical device.'
    );
  }
  if (selector === undefined) {
    if (devices.length === 1) {
      return devices[0].serial;
    }
    const available = await formatAvailableDevices(manager, devices);
    throw new Error(
      'Multiple devices found. Specify a target device using `--device <name|serial>`.\n' +
        `Available devices:\n${available}`
    );
  }
  const target = selector.trim();
  if (!target) {
    throw new Error('--device must not be empty.');
  }
  const info = await manager.getDeviceInfo(devices, target);
  if (!info) {
    throw new Error(`Device "${target}" not found.`);
  }
  return info.serial;
}

async function formatAvailableDevices(
  manager: DeviceManager,
  devices: { serial: string }[]
): Promise<string> {
  const rows = await Promise.all(
    devices.map(async (device) => {
      const name = await manager.getDeviceName(device.serial);
      return `  - ${name} (${device.serial})`;
    })
  );
  return rows.join('\n');
}

function buildSnapshotArgs(ctx: ScreenshotContext, type?: string): string[] {
  const args = ['-t', ctx.serial, 'shell', 'snapshot_display'];
  if (ctx.display?.trim()) {
    args.push('-i', parseDisplayId(ctx.display));
  }
  args.push('-f', ctx.remotePath);
  if (type) {
    args.push('-t', type);
  }
  return args;
}

function parseDisplayId(input: string): string {
  const text = input.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error('--display must be a non-negative integer.');
  }
  return text;
}

function moveScreenshotToDestination(
  sourcePath: string,
  localPath: string
): void {
  fs.copyFileSync(sourcePath, localPath);
  assertPngFile(localPath);
}

function parseRemoteFileSize(output: string): number | undefined {
  const text = output.trim();
  if (!text || /No such file|not found|cannot access/i.test(text)) {
    return undefined;
  }
  const fields = text.split(/\s+/);
  const size = Number(fields[4]);
  return Number.isFinite(size) ? size : undefined;
}

async function getRemoteScreenshotSize(
  ctx: ScreenshotContext
): Promise<number | undefined> {
  const output = await tryRunHdc(ctx.hdcPath, [
    '-t',
    ctx.serial,
    'shell',
    'ls',
    '-l',
    ctx.remotePath,
  ]);
  return parseRemoteFileSize(output);
}

function formatHdcOutput(result: HdcResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

async function tryCreateRemoteScreenshot(
  ctx: ScreenshotContext,
  type?: string
): Promise<{ created: boolean; output: string }> {
  let result: HdcResult;
  try {
    result = await runHdcResult(ctx.hdcPath, buildSnapshotArgs(ctx, type));
  } catch (error) {
    result = {
      stdout: (error as { stdout?: string }).stdout ?? '',
      stderr:
        (error as { stderr?: string; message?: string }).stderr ??
        (error as Error).message,
    };
  }
  const size = await getRemoteScreenshotSize(ctx);
  return {
    created: size !== undefined && size > 0,
    output: formatHdcOutput(result),
  };
}

async function createRemoteScreenshot(ctx: ScreenshotContext): Promise<void> {
  const outputs: string[] = [];
  for (const type of [undefined, 'png']) {
    const result = await tryCreateRemoteScreenshot(ctx, type);
    if (result.created) {
      return;
    }
    if (result.output) {
      outputs.push(result.output);
    }
  }
  throw new Error(
    outputs.length > 0
      ? `Screenshot was not created on device: ${ctx.remotePath}. snapshot_display output: ${outputs.join('\n')}`
      : `Screenshot was not created on device: ${ctx.remotePath}.`
  );
}

function isPngFile(filePath: string): boolean {
  try {
    assertPngFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function findPngFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findPngFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isPngFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function findReceivedScreenshot(
  receiveDir: string,
  remotePath: string
): string | undefined {
  const expected = path.join(receiveDir, path.basename(remotePath));
  if (isPngFile(expected)) {
    return expected;
  }
  const files = findPngFiles(receiveDir);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    throw new Error(
      `Multiple screenshot files were received in ${receiveDir}.`
    );
  }
  return undefined;
}

async function tryReceiveScreenshot(
  ctx: ScreenshotContext,
  receiveDir: string,
  localTarget: string,
  cwd?: string
): Promise<string | undefined> {
  try {
    await runHdc(
      ctx.hdcPath,
      ['-t', ctx.serial, 'file', 'recv', ctx.remotePath, localTarget],
      cwd
    );
  } catch (error) {
    debugLog(`hdc file recv failed: ${(error as Error).message}`);
  }
  return findReceivedScreenshot(receiveDir, ctx.remotePath);
}

async function receiveScreenshotFile(ctx: ScreenshotContext): Promise<void> {
  const receiveDir = fs.mkdtempSync(
    path.join(path.dirname(ctx.localPath), '.devecocli-screenshot-')
  );
  try {
    const receivedPath =
      (await tryReceiveScreenshot(ctx, receiveDir, '.', receiveDir)) ??
      (await tryReceiveScreenshot(ctx, receiveDir, receiveDir)) ??
      (await tryReceiveScreenshot(
        ctx,
        receiveDir,
        path.join(receiveDir, 'screenshot.png')
      ));
    if (!receivedPath) {
      throw new Error(`Screenshot file was not created in ${receiveDir}.`);
    }
    moveScreenshotToDestination(receivedPath, ctx.localPath);
  } finally {
    fs.rmSync(receiveDir, { recursive: true, force: true });
  }
}

async function removeRemoteScreenshot(ctx: ScreenshotContext): Promise<void> {
  await runHdc(ctx.hdcPath, [
    '-t',
    ctx.serial,
    'shell',
    'rm',
    '-f',
    ctx.remotePath,
  ]).catch(() => undefined);
}

async function captureScreenshot(ctx: ScreenshotContext): Promise<void> {
  try {
    await createRemoteScreenshot(ctx);
    await receiveScreenshotFile(ctx);
  } finally {
    await removeRemoteScreenshot(ctx);
  }
}

async function screenshotAction(options: ScreenshotOptions): Promise<void> {
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveTargetSerial(toolProvider, options.device);
    const localPath = resolveLocalPath(options.path);
    const remotePath = `/data/local/tmp/devecocli-${randomUUID()}.png`;
    await captureScreenshot({
      hdcPath: toolProvider.hdcPath,
      serial,
      localPath,
      remotePath,
      display: options.display,
    });
    console.log(green(`Screenshot saved to ${localPath}`));
  } catch (error) {
    console.error(
      red(`Failed to capture screenshot: ${(error as Error).message}`)
    );
    process.exit(1);
  }
}

export const screenshotCommand = new Command('screenshot')
  .description('Capture a screenshot of the device screen')
  .option(
    '--device <name|serial>',
    'Target device name or serial; required when multiple devices are connected'
  )
  .option('--display <displayId>', 'Target display id')
  .option(
    '--path <path>',
    'Existing directory or PNG file path whose parent exists'
  )
  .action(screenshotAction);
