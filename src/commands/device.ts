/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  tryGetHdcShellParam,
  tryGetHdcShellParams,
} from '../utils/hdc-param.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import type { EmulatorInfo } from '../service/emulator-types.js';
import { isLocalEmulatorSerial } from '../utils/emulator-hdc-targets.js';
import { red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { exitWithListCommandError } from '../utils/ora-fail.js';

interface DeviceListEntry {
  serial?: string;
  name?: string;
  isEmulator: boolean;
  isConnected: boolean;
}

interface DeviceInfo {
  serial: string;
  status: string;
  deviceType?: string;
  osVersion?: string;
}

class DeviceManager {
  private hdcPath: string;

  private constructor(hdcPath: string) {
    this.hdcPath = hdcPath;
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private stripBrandPrefix(name: string, brand?: string): string {
    const trimmedName = name.trim();
    const trimmedBrand = brand?.trim();
    if (!trimmedName || !trimmedBrand) {
      return trimmedName;
    }
    const prefix = new RegExp(
      `^${this.escapeRegExp(trimmedBrand)}(\\s+|[-_]+)?`,
      'i'
    );
    const stripped = trimmedName.replace(prefix, '').trim();
    return stripped || trimmedName;
  }

  public static from(toolProvider: ToolProvider): DeviceManager {
    return new DeviceManager(toolProvider.hdcPath);
  }

  private async executeHdc(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    return execa(this.hdcPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  public async listDevices(): Promise<DeviceInfo[]> {
    const { stdout } = await this.executeHdc(['list', 'targets']);
    const devices: DeviceInfo[] = [];

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[Empty]')) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      const serial = parts[0];
      if (!serial || serial.startsWith('[Empty]')) {
        continue;
      }
      devices.push({
        serial,
        status: parts.length >= 2 ? parts[1] : 'device',
      });
    }

    return devices;
  }

  public async getDeviceModel(serial: string): Promise<string> {
    try {
      const params = await tryGetHdcShellParams(this.hdcPath, serial, [
        'const.product.brand',
        'const.product.model',
        'const.product.name',
      ]);
      const brandStr = params.get('const.product.brand') ?? '';
      const modelStr = params.get('const.product.model') ?? '';
      const nameStr = params.get('const.product.name') ?? '';
      const displayName =
        modelStr && modelStr !== 'emulator' ? modelStr : nameStr || modelStr;
      const shouldStripBrand =
        Boolean(brandStr) && Boolean(modelStr) && modelStr !== 'emulator';
      const cleanedName = shouldStripBrand
        ? this.stripBrandPrefix(displayName, brandStr)
        : displayName.trim();
      return cleanedName || serial;
    } catch {
      return serial;
    }
  }

  public async getDeviceName(serial: string): Promise<string> {
    try {
      const hvd = await this.executeHdc([
        '-t',
        serial,
        'shell',
        'param',
        'get',
        'ohos.qemu.hvd.name',
      ]);
      const hvdStr = hvd.stdout.trim();
      if (
        hvdStr &&
        !hvdStr.includes('fail!') &&
        !hvdStr.includes('not found')
      ) {
        return hvdStr;
      }
    } catch {
      // Ignore
    }
    return this.getDeviceModel(serial);
  }

  public async getDeviceInfo(
    devices: DeviceInfo[],
    deviceSelector?: string
  ): Promise<DeviceInfo | null> {
    if (devices.length === 0) {
      return null;
    }

    if (deviceSelector) {
      const bySerial = devices.find((d) => d.serial === deviceSelector);
      if (bySerial) {
        return bySerial;
      }

      const needle = deviceSelector.toLowerCase();
      const matches: { device: DeviceInfo; name: string }[] = [];
      for (const d of devices) {
        const name = await this.getDeviceName(d.serial);
        if (name.toLowerCase().includes(needle)) {
          matches.push({ device: d, name });
        }
      }

      if (matches.length === 1) {
        return matches[0].device;
      }
      if (matches.length > 1) {
        throw new Error(
          `Multiple devices match "${deviceSelector}". Please use a serial instead:\n` +
            matches.map((m) => `  - ${m.name} (${m.device.serial})`).join('\n')
        );
      }

      throw new Error(
        `Device "${deviceSelector}" not found. Use \`devecocli device list\` to see available targets.`
      );
    }

    return devices[0];
  }

  public async getDeviceDetail(serial: string): Promise<DeviceInfo> {
    const detail: DeviceInfo = { serial, status: 'device' };
    try {
      const params = await tryGetHdcShellParams(this.hdcPath, serial, [
        'const.product.devicetype',
        'const.ohos.apiversion',
        'const.ohos.releasetype',
      ]);
      detail.deviceType = params.get('const.product.devicetype');
      const apiVer = params.get('const.ohos.apiversion');
      const relType = params.get('const.ohos.releasetype');
      if (apiVer) {
        detail.osVersion = relType
          ? `API ${apiVer} (${relType})`
          : `API ${apiVer}`;
      }
    } catch {
      // Ignore errors, partial info is acceptable
    }
    return detail;
  }
}

async function resolveConnectedEntries(
  hdcPath: string,
  serials: string[]
): Promise<{ entries: DeviceListEntry[]; runningEmulatorNames: Set<string> }> {
  const entries = await Promise.all(
    serials.map(async (serial): Promise<DeviceListEntry> => {
      const isEmulator = isLocalEmulatorSerial(serial);
      const paramKey = isEmulator ? 'ohos.qemu.hvd.name' : 'const.product.name';
      let name: string | undefined;
      try {
        name = await tryGetHdcShellParam(hdcPath, serial, paramKey);
      } catch {
        name = undefined;
      }
      return { serial, name, isEmulator, isConnected: true };
    })
  );

  const runningEmulatorNames = new Set<string>();
  for (const entry of entries) {
    if (entry.isEmulator && entry.name) {
      runningEmulatorNames.add(entry.name);
    }
  }

  return { entries, runningEmulatorNames };
}

async function loadInstalledEmulators(
  toolProvider: ToolProvider
): Promise<EmulatorInfo[]> {
  if (!toolProvider.emulatorPath) {
    return [];
  }
  try {
    const emulatorManager = EmulatorManager.from(toolProvider);
    return await emulatorManager.listEmulators();
  } catch {
    return [];
  }
}

function appendOfflineEmulators(
  installed: EmulatorInfo[],
  runningEmulatorNames: Set<string>,
  entries: DeviceListEntry[]
): void {
  for (const emu of installed) {
    if (!emu.name || runningEmulatorNames.has(emu.name)) {
      continue;
    }
    entries.push({
      name: emu.name,
      isEmulator: true,
      isConnected: false,
    });
  }
}

function printDeviceEntry(entry: DeviceListEntry): void {
  const display = entry.name ?? entry.serial ?? '';
  const status = entry.isConnected
    ? (entry.serial ?? 'connected')
    : 'not connected';
  const tag = entry.isEmulator ? 'emulator' : 'device';
  console.log(`  ${display} [${status}]  ${gray(`(${tag})`)}`);
}

async function listAction(
  deviceManager: DeviceManager,
  toolProvider: ToolProvider,
  spinner?: Ora
) {
  try {
    const devices = await deviceManager.listDevices();
    const serials = devices.map((d) => d.serial);

    const [{ entries, runningEmulatorNames }, installed] = await Promise.all([
      resolveConnectedEntries(toolProvider.hdcPath, serials),
      loadInstalledEmulators(toolProvider),
    ]);
    appendOfflineEmulators(installed, runningEmulatorNames, entries);

    spinner?.stop();
    if (entries.length === 0) {
      console.log('  [Empty]');
    } else {
      for (const entry of entries) {
        printDeviceEntry(entry);
      }
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
