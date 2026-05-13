/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { tryGetHdcShellParams } from '../utils/hdc-param.js';
import { green, cyan, red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { exitWithListCommandError } from '../utils/ora-fail.js';
import type { EmulatorInfo } from '../service/emulator-types.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  fetchEmulatorSerials,
  fetchRunningEmulatorHvds,
} from '../utils/emulator-hdc-targets.js';

const SERIAL_PARAM_KEYS = [
  'ohos.qemu.hvd.name',
  'const.product.name',
  'const.product.model',
];

function printEmulatorDetail(
  emu: EmulatorInfo,
  serial: string | undefined,
  effectiveRunning: boolean
) {
  const statusText = effectiveRunning ? (serial ?? 'running') : 'stopped';
  console.log(`  ${emu.name} [${statusText}]`);
}


async function fetchSerialParamsBatched(
  hdcPath: string,
  serials: string[]
): Promise<Map<string, Map<string, string>>> {
  const entries = await Promise.all(
    serials.map(async (serial) => {
      const params = await tryGetHdcShellParams(
        hdcPath,
        serial,
        SERIAL_PARAM_KEYS
      );
      return [serial, params] as const;
    })
  );
  return new Map(entries);
}

async function fetchEmulatorListSnapshot(hdcPath: string): Promise<{
  serials: string[];
  params: Map<string, Map<string, string>>;
}> {
  const serials = await fetchEmulatorSerials(hdcPath);
  const params = await fetchSerialParamsBatched(hdcPath, serials);
  return { serials, params };
}

function tryMatchProductSerial(
  serial: string,
  params: Map<string, string> | undefined,
  unmatchedNames: string[],
  unmatchedSerials: string[],
  productSerialMap: Map<string, string>
): void {
  if (!params) {
    return;
  }
  for (const key of ['const.product.name', 'const.product.model']) {
    const value = params.get(key);
    if (!value) {
      continue;
    }
    const idx = unmatchedNames.indexOf(value);
    if (idx === -1) {
      continue;
    }
    unmatchedNames.splice(idx, 1);
    productSerialMap.set(value, serial);
    const sIdx = unmatchedSerials.indexOf(serial);
    if (sIdx !== -1) {
      unmatchedSerials.splice(sIdx, 1);
    }
    return;
  }
}

/** Pure-function map builder over already-fetched params. */
function buildEmulatorMapsFromParams(
  serials: string[],
  serialParams: Map<string, Map<string, string>>,
  runningEmulatorNames: string[]
): {
  productSerialMap: Map<string, string>;
  hvdSerialMap: Map<string, string>;
} {
  const productSerialMap = new Map<string, string>();
  const hvdSerialMap = new Map<string, string>();
  const unmatchedSerials = [...serials];
  const unmatchedNames = [...runningEmulatorNames];
  for (const serial of serials) {
    const params = serialParams.get(serial);
    const hvd = params?.get('ohos.qemu.hvd.name');
    if (hvd) {
      hvdSerialMap.set(hvd, serial);
    }
    if (runningEmulatorNames.length > 0) {
      tryMatchProductSerial(
        serial,
        params,
        unmatchedNames,
        unmatchedSerials,
        productSerialMap
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

async function listAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  spinner?: Ora
) {
  try {
    const [emulators, hdcSnapshot] = await Promise.all([
      emulatorManager.listEmulators(),
      fetchEmulatorListSnapshot(hdcPath),
    ]);

    if (emulators.length === 0) {
      spinner?.stop();
      console.log(yellow('  No emulator instances found.'));
      console.log(gray('  You can create an emulator in DevEco Studio.'));
      console.log('');
      return;
    }

    const runningNames = emulators
      .filter((e) => e.isRunning)
      .map((e) => e.name);

    const { productSerialMap, hvdSerialMap } = buildEmulatorMapsFromParams(
      hdcSnapshot.serials,
      hdcSnapshot.params,
      runningNames
    );

    spinner?.stop();
    for (const emu of emulators) {
      const serial =
        productSerialMap.get(emu.name) ?? hvdSerialMap.get(emu.name);
      const effectiveRunning =
        emu.isRunning === true || hvdSerialMap.has(emu.name);
      printEmulatorDetail(emu, serial, effectiveRunning);
    }
    console.log('');
  } catch (error) {
    exitWithListCommandError(
      spinner,
      `Failed to list emulators: ${(error as Error).message}`
    );
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

async function isEmulatorPresentByHdcName(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const targetKey = normalizeListNameKey(name);
  const hvds = await fetchRunningEmulatorHvds(hdcPath);
  return hvds.some((hvd) => normalizeListNameKey(hvd) === targetKey);
}

/**
 * Poll `hdc list targets` until the named emulator reaches the desired
 * presence state (appeared / disappeared), or until the timeout is reached.
 * Returns true when confirmed, false on timeout.
 */
async function waitForEmulatorHdcState(
  hdcPath: string,
  name: string,
  expectPresent: boolean,
  timeoutMs = EMULATOR_CONFIRM_TIMEOUT_MS,
  intervalMs = EMULATOR_CONFIRM_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await isEmulatorPresentByHdcName(hdcPath, name);
    if (present === expectPresent) {
      return true;
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

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, true);
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

async function stopAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  name: string
) {
  console.log(cyan(`Stopping emulator "${name}"...`));
  try {
    await emulatorManager.stopEmulator(name);
  } catch (error) {
    handleError('stop', name, error);
  }

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, false);
  if (confirmed) {
    console.log(green(`Emulator "${name}" stopped successfully!`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" stop signal was sent but the instance is still visible in hdc list targets within the timeout.`
      )
    );
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
    const spinner = ora({
      text: 'Listing emulators…',
      color: 'cyan',
    }).start();
    await listAction(manager, toolProvider.hdcPath, spinner);
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
    const { manager, toolProvider } = await initEmulatorManager();
    await stopAction(manager, toolProvider.hdcPath, name);
  });

export default emulatorCommand;
