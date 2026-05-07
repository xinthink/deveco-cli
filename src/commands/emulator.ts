/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { ToolProvider } from '../utils/tool-provider.js';
import * as path from 'path';
import { green, cyan, red, yellow, gray } from 'colorette';

interface EmulatorInfo {
  name: string;
  isRunning?: boolean;
  instancePath?: string;
  path?: string;
  imageRoot?: string;
}

class EmulatorManager {
  private emulatorPath: string;
  private sdkPath: string;

  private constructor(emulatorPath: string, sdkPath: string) {
    this.emulatorPath = emulatorPath;
    this.sdkPath = sdkPath;
  }

  public static async new(): Promise<EmulatorManager> {
    const toolProvider = await ToolProvider.new();
    return new EmulatorManager(toolProvider.emulatorPath, toolProvider.sdkPath);
  }

  private async executeEmulator(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
    });
  }

  public async listEmulators(): Promise<EmulatorInfo[]> {
    const { stdout } = await this.executeEmulator(['-list', '-details']);
    return this.parseListOutput(stdout);
  }

  private parseListOutput(output: string): EmulatorInfo[] {
    try {
      const jsonOutput = JSON.parse(output);
      if (Array.isArray(jsonOutput)) {
        return jsonOutput.map((item: Record<string, unknown>) => ({
          name: (item.name || item.Name || '') as string,
          isRunning: item.isRunning === true || item.isRunning === 'true',
          instancePath: (item.instancePath || item.instance_path || item.InstancePath || '') as string,
          path: (item.path || item.Path || '') as string,
          imageRoot: (item.imageRoot || item.image_root || item.ImageRoot || '') as string,
        })).filter((emu: EmulatorInfo) => emu.name);
      }
    } catch {
      // Fallback to text parsing
    }

    const emulators: EmulatorInfo[] = [];
    const fieldRegex = /^(name|isrunning|instancepath|path|imageroot)\s*:\s*(.+)/gim;

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
        current[key.toLowerCase() as keyof EmulatorInfo] = key === 'isrunning'
          ? value.trim().toLowerCase() === 'true'
          : value.trim();
      }
    }

    if (current) {
      emulators.push(current);
    }
    return emulators;
  }

  public async startEmulator(name: string): Promise<void> {
    const emulators = await this.listEmulators();
    const targetEmulator = emulators.find((e) => e.name === name);

    if (!targetEmulator) {
      throw new Error(`Emulator "${name}" not found.`);
    }

    const candidates = this.buildStartCandidates(name, targetEmulator);
    let lastError: Error | undefined;

    for (const args of candidates) {
      try {
        await this.executeEmulator(args);
        return;
      } catch (err) {
        lastError = err as Error;
        continue;
      }
    }

    throw new Error(
      `Unable to start emulator "${name}". All methods failed.\nLast error: ${lastError?.message || 'unknown'}`
    );
  }

  /**
   * Build start argument candidates in priority order.
   * Path sources: parentPath → instancePath → path
   * Image sources: imageRoot → none
   * Modes: -start (-instancePath) + -hvd (-path)
   */
  private buildStartCandidates(name: string, emulator: EmulatorInfo): string[][] {
    const parentPath = emulator.instancePath
      ? path.dirname(emulator.instancePath)
      : undefined;

    const candidates: string[][] = [];

    // 1. Simplest attempt (no path/image args)
    candidates.push(['-start', name]);

    // 2. Path + image combinations
    const pathSources: Array<{ value: string; startFlag: string; hvdFlag: string }> = [];
    if (parentPath) {
      pathSources.push({ value: parentPath, startFlag: '-instancePath', hvdFlag: '-path' });
    }
    if (emulator.instancePath) {
      pathSources.push({ value: emulator.instancePath, startFlag: '-instancePath', hvdFlag: '-path' });
    }
    if (emulator.path) {
      pathSources.push({ value: emulator.path, startFlag: '-instancePath', hvdFlag: '-path' });
    }

    const imageSources: string[][] = [];
    if (emulator.imageRoot) {
      imageSources.push(['-imageRoot', emulator.imageRoot]);
    }
    imageSources.push([]); // no image arg

    for (const { value: pathVal, startFlag, hvdFlag } of pathSources) {
      for (const imageArgs of imageSources) {
        candidates.push(['-start', name, startFlag, pathVal, ...imageArgs]);
        candidates.push(['-hvd', name, hvdFlag, pathVal, ...imageArgs]);
      }
    }

    // 3. Final fallback
    candidates.push(['-hvd', name]);

    return candidates;
  }

  public async stopEmulator(name: string): Promise<void> {
    await this.executeEmulator(['-stop', name]);
  }
}

interface EmulatorOptions {
  start?: boolean;
  stop?: boolean;
  list?: boolean;
  name?: string;
}

function printEmulatorDetail(emu: EmulatorInfo, serial?: string) {
  const statusText = emu.isRunning
    ? (serial ?? 'running')
    : 'stopped';
  console.log(`  ${emu.name} [${statusText}]`);
}

async function resolveHdcPath(): Promise<string | null> {
  try {
    const toolProvider = await ToolProvider.new();
    return toolProvider.hdcPath;
  } catch {
    return null;
  }
}

async function fetchEmulatorSerials(hdcPath: string): Promise<string[]> {
  try {
    const { stdout } = await execa(hdcPath, ['list', 'targets']);
    return stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((serial) => serial.startsWith('127.0.0.1:'));
  } catch {
    return [];
  }
}

async function queryParamMatch(
  hdcPath: string, serial: string, paramKey: string, unmatchedNames: string[]
): Promise<string | null> {
  try {
    const { stdout } = await execa(hdcPath, ['-t', serial, 'shell', 'param', 'get', paramKey]);
    const matchIdx = unmatchedNames.indexOf(stdout.trim());
    return matchIdx !== -1 ? unmatchedNames[matchIdx] : null;
  } catch {
    return null;
  }
}

async function matchSerialToName(
  hdcPath: string, serial: string, unmatchedNames: string[], serialMap: Map<string, string>, unmatchedSerials: string[]
): Promise<boolean> {
  const paramKeys = ['const.product.name', 'const.product.model'];
  for (const paramKey of paramKeys) {
    const matchedName = await queryParamMatch(hdcPath, serial, paramKey, unmatchedNames);
    if (!matchedName) {
      continue;
    }

    unmatchedNames.splice(unmatchedNames.indexOf(matchedName), 1);
    serialMap.set(matchedName, serial);
    const serialIdx = unmatchedSerials.indexOf(serial);
    if (serialIdx !== -1) {
      unmatchedSerials.splice(serialIdx, 1);
    }
    return true;
  }
  return false;
}

async function getEmulatorSerials(runningEmulatorNames: string[]): Promise<Map<string, string>> {
  const serialMap = new Map<string, string>();
  if (runningEmulatorNames.length === 0) {
    return serialMap;
  }

  const hdcPath = await resolveHdcPath();
  if (!hdcPath) {
    return serialMap;
  }

  const emulatorSerials = await fetchEmulatorSerials(hdcPath);
  if (emulatorSerials.length === 0) {
    return serialMap;
  }

  const unmatchedSerials = [...emulatorSerials];
  const unmatchedNames = [...runningEmulatorNames];

  for (const serial of emulatorSerials) {
    await matchSerialToName(hdcPath, serial, unmatchedNames, serialMap, unmatchedSerials);
  }

  // Fallback: assign remaining serials to remaining running emulators in order
  for (let i = 0; i < unmatchedNames.length && i < unmatchedSerials.length; i++) {
    serialMap.set(unmatchedNames[i], unmatchedSerials[i]);
  }

  return serialMap;
}

async function listAction(emulatorManager: EmulatorManager) {
  try {
    const emulators = await emulatorManager.listEmulators();

    if (emulators.length === 0) {
      console.log(yellow('  No emulator instances found.'));
      console.log(gray('  You can create an emulator in DevEco Studio.'));
      console.log('');
      return;
    }

    const runningNames = emulators.filter((e) => e.isRunning).map((e) => e.name);
    const serialMap = await getEmulatorSerials(runningNames);

    for (const emu of emulators) {
      const serial = emu.isRunning ? serialMap.get(emu.name) : undefined;
      printEmulatorDetail(emu, serial);
    }
    console.log('');
  } catch (error) {
    console.error(red(`Failed to list emulators: ${(error as Error).message}`));
    process.exit(1);
  }
}

function handleError(action: string, name: string, error: unknown): never {
  const e = error as Error & { stdout?: string; stderr?: string };
  console.error(red(`Failed to ${action} emulator "${name}": ${e.message}`));
  if (e.stdout) {
    console.error(gray(e.stdout));
  }
  if (e.stderr) {
    console.error(gray(e.stderr));
  }
  process.exit(1);
}

async function startAction(emulatorManager: EmulatorManager, name: string) {
  console.log(cyan(`Starting emulator "${name}"...`));
  try {
    await emulatorManager.startEmulator(name);
  } catch (error) {
    handleError('start', name, error);
  }
}

async function stopAction(emulatorManager: EmulatorManager, name: string) {
  console.log(cyan(`Stopping emulator "${name}"...`));
  try {
    await emulatorManager.stopEmulator(name);
    console.log(green(`Emulator "${name}" stopped successfully!`));
  } catch (error) {
    handleError('stop', name, error);
  }
}

const emulatorCommand = new Command('emulator')
  .description('Emulator management commands')
  .option('--list', 'List all emulator instances')
  .option('--start', 'Start an emulator')
  .option('--stop', 'Stop an emulator')
  .option('--name <name>', 'Emulator instance name')
  .action(async (options: EmulatorOptions) => {
    let emulatorManager: EmulatorManager;
    try {
      emulatorManager = await EmulatorManager.new();
    } catch (error) {
      console.error(red(`Failed to initialize emulator: ${(error as Error).message}`));
      process.exit(1);
      return;
    }

    if (options.list) {
      await listAction(emulatorManager);
    } else if (options.start) {
      if (!options.name) {
        console.error(red('Error: --name is required when using --start'));
        process.exit(1);
      }
      await startAction(emulatorManager, options.name);
    } else if (options.stop) {
      if (!options.name) {
        console.error(red('Error: --name is required when using --stop'));
        process.exit(1);
      }
      await stopAction(emulatorManager, options.name);
    } else {
      emulatorCommand.outputHelp();
    }
  });

export default emulatorCommand;
