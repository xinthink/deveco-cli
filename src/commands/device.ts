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
import * as path from 'path';
import fs from 'fs-extra';
import { green, cyan, red, yellow, gray } from 'colorette';
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
      if (brandStr && displayName) {
        return `${brandStr} ${displayName}`;
      }
      return displayName || brandStr || serial;
    } catch {
      return serial;
    }
  }

  public async getDeviceInfo(
    devices: DeviceInfo[],
    deviceSerial?: string
  ): Promise<DeviceInfo | null> {
    if (devices.length === 0) {
      return null;
    }

    if (deviceSerial) {
      return devices.find((d) => d.serial === deviceSerial) || null;
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
    const modelName = await deviceManager.getDeviceModel(device.serial);
    console.error(gray(`  ${commandHint} -t ${device.serial}  # ${modelName}`));
  }
  process.exit(1);
}

async function viewAction(deviceManager: DeviceManager, deviceSerial?: string) {
  try {
    if (!deviceSerial) {
      await checkMultiDevice(deviceManager, 'deveco device view');
    }

    const devices = await deviceManager.listDevices();
    const info = await deviceManager.getDeviceInfo(devices, deviceSerial);
    if (!info) {
      console.log(yellow('No connected device found.'));
      process.exit(1);
    }

    const detail = await deviceManager.getDeviceDetail(info.serial);
    console.log(`  Serial:      ${info.serial}`);
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

async function startAppAfterInstall(
  deviceManager: DeviceManager,
  bundleName: string,
  ability: string,
  deviceSerial?: string
) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(cyan(`Starting app: ${bundleName}/${ability}`));
  await deviceManager.startApp(bundleName, ability, deviceSerial);
  console.log(green('App started successfully!'));
}

async function installAction(
  deviceManager: DeviceManager,
  packagePaths: string[],
  deviceSerial?: string,
  bundleName?: string,
  ability?: string
) {
  try {
    if (!deviceSerial) {
      await checkMultiDevice(
        deviceManager,
        `deveco device install ${packagePaths.join(' ')}`
      );
    }

    await deviceManager.installApp(packagePaths, deviceSerial);
    console.log(green('App installed successfully!'));

    if (bundleName && ability) {
      await startAppAfterInstall(
        deviceManager,
        bundleName,
        ability,
        deviceSerial
      );
    }
  } catch (error) {
    console.error(red(`Failed to install app: ${(error as Error).message}`));
    process.exit(1);
  }
}

async function uninstallAction(
  deviceManager: DeviceManager,
  bundleName: string,
  deviceSerial?: string
) {
  try {
    if (!deviceSerial) {
      await checkMultiDevice(
        deviceManager,
        `deveco device uninstall ${bundleName}`
      );
    }

    console.log(cyan(`Uninstalling app: ${bundleName}`));
    await deviceManager.uninstallApp(bundleName, deviceSerial);
    console.log(green('App uninstalled successfully!'));
  } catch (error) {
    console.error(red(`Failed to uninstall app: ${(error as Error).message}`));
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
  .option('-t, --target <serial>', 'Target device serial number')
  .action(async (options: { target?: string }) => {
    const { manager } = await initDeviceManager();
    await infoAction(manager, options.target);
  });

deviceCommand
  .command('install <packagePaths...>')
  .description('Install one or more packages (.hap / .hsp)')
  .option('-t, --target <serial>', 'Target device serial number')
  .option(
    '-b, --bundle-name <name>',
    'Bundle name for launching the app after install'
  )
  .option(
    '-a, --ability <abilityName>',
    'Ability name for launching the app after install'
  )
  .action(
    async (
      packagePaths: string[],
      options: { target?: string; bundleName?: string; ability?: string }
    ) => {
      const { manager } = await initDeviceManager();
      await installAction(
        manager,
        packagePaths,
        options.target,
        options.bundleName,
        options.ability
      );
    }
  );

deviceCommand
  .command('uninstall <bundleName>')
  .description('Uninstall an application by bundle name')
  .option('-t, --target <serial>', 'Target device serial number')
  .action(async (bundleName: string, options: { target?: string }) => {
    const { manager } = await initDeviceManager();
    await uninstallAction(manager, bundleName, options.target);
  });

export default deviceCommand;
