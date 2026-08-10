/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import {
  DeviceManager,
  type ConnectedDeviceEntry,
  isLocalEmulatorSerial,
} from '../service/device-manager.js';
import { red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { renderTable, type TableRow } from '../utils/text-table.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
  TraceError,
} from '../trace/index.js';

async function withDeviceTrace(
  event: CommandExecuted,
  action: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await action();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    console.error(red((error as Error).message));
    process.exitCode = 1;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

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

type DeviceOutputFormat = 'table' | 'json';

interface DeviceJsonDto {
  name: string;
  serial: string;
  kind: 'device' | 'emulator';
  deviceType?: string;
  osVersion?: string;
}

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

function buildDeviceListJsonDto(entry: ConnectedDeviceEntry): DeviceJsonDto {
  return {
    name: entry.name ?? entry.serial,
    serial: entry.serial,
    kind: entry.isEmulator ? 'emulator' : 'device',
    deviceType: entry.deviceType,
  };
}

function printDeviceListJson(entries: ConnectedDeviceEntry[]): void {
  const sorted = [...entries].sort(compareDeviceEntries);
  console.log(JSON.stringify(sorted.map(buildDeviceListJsonDto), null, 2));
}

async function applyEmulatorOverridesIfNeeded(
  entries: ConnectedDeviceEntry[],
  toolProvider: ToolProvider
): Promise<void> {
  const hasEmulator = entries.some((e) => e.isEmulator);
  if (!hasEmulator || !toolProvider.emulatorPath) {
    return;
  }
  const overrides =
    await EmulatorManager.from(toolProvider).getDeviceTypeByName();
  applyEmulatorDeviceTypeOverrides(entries, overrides);
}

async function listAction(
  deviceManager: DeviceManager,
  toolProvider: ToolProvider,
  spinner?: Ora,
  format: DeviceOutputFormat = 'table'
): Promise<void> {
  try {
    const entries = await deviceManager.getConnectedEntries();
    await applyEmulatorOverridesIfNeeded(entries, toolProvider);

    spinner?.stop();
    if (format === 'json') {
      printDeviceListJson(entries);
      return;
    }

    if (entries.length === 0) {
      printNoDevicesHint();
    } else {
      printDeviceListTable(entries);
    }
  } catch (error) {
    throw new TraceError(
      `Failed to list devices: ${(error as Error).message}`,
      'Failed to list devices.'
    );
  } finally {
    spinner?.stop();
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
  const lines = ['Multiple devices connected. Specify a device with:'];
  for (const device of devices) {
    const deviceName = await deviceManager.getDeviceName(device.serial);
    lines.push(`  ${commandHint} -t ${device.serial}  # ${deviceName}`);
  }
  throw new TraceError(lines.join('\n'), 'Multiple devices connected.');
}

async function viewAction(
  deviceManager: DeviceManager,
  deviceSelector?: string,
  format: DeviceOutputFormat = 'table'
): Promise<void> {
  if (!deviceSelector) {
    await checkMultiDevice(deviceManager, 'devecocli device view');
  }

  const devices = await deviceManager.listDevices();
  const info = await deviceManager.getDeviceInfo(devices, deviceSelector);
  if (!info) {
    if (format === 'json') {
      console.error('No connected device found.');
      process.exitCode = 1;
      return;
    }
    throw new TraceError('No connected device found.');
  }

  const detail = await deviceManager.getDeviceDetail(info.serial);
  const deviceName = await deviceManager.getDeviceName(info.serial);
  if (format === 'json') {
    const json: DeviceJsonDto = {
      name: deviceName,
      serial: info.serial,
      kind: isLocalEmulatorSerial(info.serial) ? 'emulator' : 'device',
      deviceType: detail.deviceType,
      osVersion: detail.osVersion,
    };
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  console.log(`  Serial:      ${info.serial}`);
  console.log(`  Device Name: ${deviceName}`);
  if (detail.deviceType) {
    console.log(`  Device Type: ${detail.deviceType}`);
  }
  if (detail.osVersion) {
    console.log(`  OS Version:  ${detail.osVersion}`);
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
    throw new TraceError(
      `Failed to initialize device manager: ${(error as Error).message}`,
      'Failed to initialize device manager.'
    );
  }
}

const deviceCommand = new Command('device').description(
  'Manage connected devices'
);

deviceCommand
  .command('list')
  .description('List all connected devices')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['table', 'json'])
      .default('table')
  )
  .action(async (options: { format: DeviceOutputFormat }) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'list', ...(options.format === 'json' ? ['--format', 'json'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { manager, toolProvider } = await initDeviceManager();
      if (options.format === 'json') {
        await listAction(manager, toolProvider, undefined, 'json');
        return;
      }

      const spinner = ora({
        text: 'Querying connected devices…',
        color: 'cyan',
      }).start();
      await listAction(manager, toolProvider, spinner, 'table');
    });
  });

deviceCommand
  .command('view')
  .description('Show detailed device information')
  .option('-t, --target <serialOrName>', 'Target device serial or device name')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['table', 'json'])
      .default('table')
  )
  .action(async (options: { target?: string; format: DeviceOutputFormat }) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device', 'view',
        ...(options.target ? ['--target'] : []),
        ...(options.format === 'json' ? ['--format', 'json'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { manager } = await initDeviceManager();
      await viewAction(manager, options.target, options.format);
    });
  });

export default deviceCommand;
