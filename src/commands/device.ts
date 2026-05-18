/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../utils/tool-provider.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import {
  DeviceManager,
  type ConnectedDeviceEntry,
} from '../service/device-manager.js';
import { red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { exitWithListCommandError } from '../utils/ora-fail.js';
import { renderTable, type TableRow } from '../utils/text-table.js';

function applyEmulatorDeviceTypeOverrides(
  entries: ConnectedDeviceEntry[],
  emulatorDeviceTypeByName: Map<string, string>
): void {
  if (emulatorDeviceTypeByName.size === 0) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isEmulator || !entry.name) {
      continue;
    }
    const fine = emulatorDeviceTypeByName.get(normalizeListNameKey(entry.name));
    if (fine) {
      entry.deviceType = fine;
    }
  }
}

const DEVICE_LIST_TABLE_HEADERS = [
  'Name',
  'Serial',
  'Kind',
  'Device Type',
] as const;

function buildDeviceListRow(entry: ConnectedDeviceEntry): TableRow {
  return {
    cells: [
      entry.name ?? entry.serial,
      entry.serial,
      entry.isEmulator ? 'emulator' : 'device',
      entry.deviceType ?? '-',
    ],
    highlight: true,
  };
}

function compareDeviceEntries(
  a: ConnectedDeviceEntry,
  b: ConnectedDeviceEntry
): number {
  if (a.isEmulator !== b.isEmulator) {
    return a.isEmulator ? 1 : -1;
  }
  return (a.name ?? a.serial).localeCompare(b.name ?? b.serial);
}

function printNoDevicesHint(): void {
  console.log(yellow('  No active devices.'));
  console.log(
    gray(
      '  Connect a USB device with debugging enabled, or start an emulator with `devecocli emulator start <name>`.'
    )
  );
}

function printDeviceListTable(entries: ConnectedDeviceEntry[]): void {
  const sorted = [...entries].sort(compareDeviceEntries);
  const rows = sorted.map(buildDeviceListRow);
  console.log(renderTable(DEVICE_LIST_TABLE_HEADERS, rows));
}

async function applyEmulatorOverridesIfNeeded(
  entries: ConnectedDeviceEntry[],
  toolProvider: ToolProvider
): Promise<void> {
  const hasEmulator = entries.some((e) => e.isEmulator);
  if (!hasEmulator || !toolProvider.emulatorPath) {
    return;
  }
  const overrides = await EmulatorManager.from(
    toolProvider
  ).getDeviceTypeByName();
  applyEmulatorDeviceTypeOverrides(entries, overrides);
}

async function listAction(
  deviceManager: DeviceManager,
  toolProvider: ToolProvider,
  spinner?: Ora
) {
  try {
    const entries = await deviceManager.getConnectedEntries();
    await applyEmulatorOverridesIfNeeded(entries, toolProvider);

    spinner?.stop();
    if (entries.length === 0) {
      printNoDevicesHint();
    } else {
      printDeviceListTable(entries);
    }
    console.log('');
  } catch (error) {
    exitWithListCommandError(
      spinner,
      `Failed to list devices: ${(error as Error).message}`
    );
  }
}

async function checkMultiDevice(
  deviceManager: DeviceManager,
  commandHint: string
): Promise<void> {
  const devices = await deviceManager.listDevices();
  if (devices.length < 2) {
    return;
  }
  console.error(
    red('Multiple devices connected. Please specify a device with:')
  );
  for (const device of devices) {
    const deviceName = await deviceManager.getDeviceName(device.serial);
    console.error(
      gray(`  ${commandHint} -t ${device.serial}  # ${deviceName}`)
    );
  }
  process.exit(1);
}

async function viewAction(
  deviceManager: DeviceManager,
  deviceSelector?: string
) {
  try {
    if (!deviceSelector) {
      await checkMultiDevice(deviceManager, 'devecocli device view');
    }

    const devices = await deviceManager.listDevices();
    const info = await deviceManager.getDeviceInfo(devices, deviceSelector);
    if (!info) {
      console.log(yellow('No connected device found.'));
      process.exit(1);
    }

    const detail = await deviceManager.getDeviceDetail(info.serial);
    const deviceName = await deviceManager.getDeviceName(info.serial);
    console.log(`  Serial:      ${info.serial}`);
    console.log(`  Device Name: ${deviceName}`);
    console.log(
      `  Status:      ${info.status === 'device' ? 'connected' : info.status}`
    );
    if (detail.deviceType) {
      console.log(`  Device Type: ${detail.deviceType}`);
    }
    if (detail.osVersion) {
      console.log(`  OS Version:  ${detail.osVersion}`);
    }
    console.log('');
  } catch (error) {
    console.error(
      red(`Failed to show device details: ${(error as Error).message}`)
    );
    process.exit(1);
  }
}

async function initDeviceManager(): Promise<{
  manager: DeviceManager;
  toolProvider: ToolProvider;
}> {
  try {
    const toolProvider = await ToolProvider.new();
    const manager = DeviceManager.from(toolProvider);
    return { manager, toolProvider };
  } catch (error) {
    console.error(
      red(`Failed to initialize device manager: ${(error as Error).message}`)
    );
    process.exit(1);
    return undefined as never;
  }
}

const deviceCommand = new Command('device').description(
  'Manage connected devices'
);

deviceCommand
  .command('list')
  .description('List all connected devices')
  .action(async () => {
    const { manager, toolProvider } = await initDeviceManager();
    const spinner = ora({
      text: 'Querying connected devices…',
      color: 'cyan',
    }).start();
    await listAction(manager, toolProvider, spinner);
  });

deviceCommand
  .command('view')
  .description('Show detailed device information')
  .option('-t, --target <serialOrName>', 'Target device serial or device name')
  .action(async (options: { target?: string }) => {
    const { manager } = await initDeviceManager();
    await viewAction(manager, options.target);
  });

export default deviceCommand;
