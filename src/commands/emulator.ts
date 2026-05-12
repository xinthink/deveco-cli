/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { tryGetHdcShellParam } from '../utils/hdc-param.js';
import { green, cyan, red, yellow, gray } from 'colorette';
import type { EmulatorInfo } from '../service/emulator-types.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import { ToolProvider } from '../utils/tool-provider.js';
import { fetchEmulatorSerials } from '../utils/emulator-hdc-targets.js';

function printEmulatorDetail(
  emu: EmulatorInfo,
  serial: string | undefined,
  effectiveRunning: boolean
) {
  const statusText = effectiveRunning ? (serial ?? 'running') : 'stopped';
  console.log(`  ${emu.name} [${statusText}]`);
}

async function queryParamMatch(
  hdcPath: string,
  serial: string,
  paramKey: string,
  unmatchedNames: string[]
): Promise<string | null> {
  const value = await tryGetHdcShellParam(hdcPath, serial, paramKey);
  if (!value) {
    return null;
  }
  const matchIdx = unmatchedNames.indexOf(value);
  return matchIdx !== -1 ? unmatchedNames[matchIdx] : null;
}

async function matchSerialToName(
  hdcPath: string,
  serial: string,
  unmatchedNames: string[],
  serialMap: Map<string, string>,
  unmatchedSerials: string[]
): Promise<boolean> {
  const paramKeys = ['const.product.name', 'const.product.model'];
  for (const paramKey of paramKeys) {
    const matchedName = await queryParamMatch(
      hdcPath,
      serial,
      paramKey,
      unmatchedNames
    );
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

/** One pass over local emulator serials: HVD map + product-name map for list UI. */
async function buildEmulatorHdcSerialMaps(
  hdcPath: string,
  runningEmulatorNames: string[]
): Promise<{
  productSerialMap: Map<string, string>;
  hvdSerialMap: Map<string, string>;
}> {
  const hvdSerialMap = new Map<string, string>();
  const productSerialMap = new Map<string, string>();
  const serials = await fetchEmulatorSerials(hdcPath);
  if (serials.length === 0) {
    return { productSerialMap, hvdSerialMap };
  }

  const unmatchedSerials = [...serials];
  const unmatchedNames = [...runningEmulatorNames];

  for (const serial of serials) {
    const hvd = await tryGetHdcShellParam(
      hdcPath,
      serial,
      'ohos.qemu.hvd.name'
    );
    if (hvd) {
      hvdSerialMap.set(hvd, serial);
    }

    if (runningEmulatorNames.length > 0) {
      await matchSerialToName(
        hdcPath,
        serial,
        unmatchedNames,
        productSerialMap,
        unmatchedSerials
      );
    }
  }

  for (
    let i = 0;
    i < unmatchedNames.length && i < unmatchedSerials.length;
    i++
  ) {
    productSerialMap.set(unmatchedNames[i], unmatchedSerials[i]);
  }

  return { productSerialMap, hvdSerialMap };
}

async function listAction(emulatorManager: EmulatorManager, hdcPath: string) {
  try {
    const emulators = await emulatorManager.listEmulators();

    if (emulators.length === 0) {
      console.log(yellow('  No emulator instances found.'));
      console.log(gray('  You can create an emulator in DevEco Studio.'));
      console.log('');
      return;
    }

    const runningNames = emulators
      .filter((e) => e.isRunning)
      .map((e) => e.name);

    let productSerialMap = new Map<string, string>();
    let hvdSerialMap = new Map<string, string>();
    const maps = await buildEmulatorHdcSerialMaps(hdcPath, runningNames);
    productSerialMap = maps.productSerialMap;
    hvdSerialMap = maps.hvdSerialMap;

    for (const emu of emulators) {
      const serial =
        productSerialMap.get(emu.name) ?? hvdSerialMap.get(emu.name);
      const effectiveRunning =
        emu.isRunning === true || hvdSerialMap.has(emu.name);
      printEmulatorDetail(emu, serial, effectiveRunning);
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

const EMULATOR_CONFIRM_POLL_INTERVAL_MS = 2000;
const EMULATOR_CONFIRM_TIMEOUT_MS = 60000;

/**
 * Poll `hdc list targets` until the named emulator appears (via ohos.qemu.hvd.name),
 * or until the timeout is reached.  Returns true when confirmed, false on timeout.
 */
async function waitForEmulatorByHdcName(
  hdcPath: string,
  name: string,
  timeoutMs = EMULATOR_CONFIRM_TIMEOUT_MS,
  intervalMs = EMULATOR_CONFIRM_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serials = await fetchEmulatorSerials(hdcPath);
    for (const serial of serials) {
      const hvd = await tryGetHdcShellParam(
        hdcPath,
        serial,
        'ohos.qemu.hvd.name'
      );
      if (hvd && normalizeListNameKey(hvd) === normalizeListNameKey(name)) {
        return true;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function startOneEmulator(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  name: string
): Promise<void> {
  const outcome = await emulatorManager.startEmulator(name);
  if (outcome === 'already-running') {
    console.log(yellow(`Emulator "${name}" is already running.`));
    return;
  }

  console.log(cyan(`Starting emulator "${name}"...`));

  const confirmed = await waitForEmulatorByHdcName(hdcPath, name);
  if (confirmed) {
    console.log(green(`Emulator "${name}" started successfully.`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" was launched but did not appear in hdc list targets within the timeout.`
      )
    );
  }
}

async function startAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  names: string[]
) {
  const results = await Promise.allSettled(
    names.map((name) => startOneEmulator(emulatorManager, hdcPath, name))
  );

  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      anyFailed = true;
      const e = result.reason as Error & { stdout?: string; stderr?: string };
      console.error(
        red(`Failed to start emulator "${names[i]}": ${e.message}`)
      );
      if (e.stdout) {
        console.error(gray(e.stdout));
      }
      if (e.stderr) {
        console.error(gray(e.stderr));
      }
    }
  }

  console.log('');
  if (anyFailed) {
    process.exit(1);
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

async function initEmulatorManager(): Promise<{
  manager: EmulatorManager;
  toolProvider: ToolProvider;
}> {
  try {
    const toolProvider = await ToolProvider.new();
    const manager = EmulatorManager.from(toolProvider);
    return { manager, toolProvider };
  } catch (error) {
    console.error(
      red(`Failed to initialize emulator: ${(error as Error).message}`)
    );
    process.exit(1);
    return undefined as never;
  }
}

const emulatorCommand = new Command('emulator').description(
  'Manage emulator instances'
);

emulatorCommand
  .command('list')
  .description('List all emulator instances')
  .action(async () => {
    const { manager, toolProvider } = await initEmulatorManager();
    await listAction(manager, toolProvider.hdcPath);
  });

emulatorCommand
  .command('start <names...>')
  .description('Start one or more emulator instances')
  .action(async (names: string[]) => {
    const { manager, toolProvider } = await initEmulatorManager();
    await startAction(manager, toolProvider.hdcPath, names);
  });

emulatorCommand
  .command('stop <name>')
  .description('Stop an emulator instance')
  .action(async (name: string) => {
    const { manager } = await initEmulatorManager();
    await stopAction(manager, name);
  });

export default emulatorCommand;
