/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { ToolProvider } from '../utils/tool-provider.js';
import * as path from 'path';
import fs from 'fs-extra';
import { green, cyan, red, yellow, gray } from 'colorette';

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

  public static async new(): Promise<DeviceManager> {
    const toolProvider = await ToolProvider.new();
    return new DeviceManager(toolProvider.hdcPath);
  }

  private async executeHdc(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execa(this.hdcPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result;
  }

  private extractHdcFailure(output: string): string | null {
    const normalized = output.replace(/\r/g, '');
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const failurePatterns = [
      'failed to ',
      'error:',
      'install failed',
      'uninstall failed',
      'msg:error',
      'failed to uninstall',
      '[fail]',
    ];

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (failurePatterns.some((p) => lower.includes(p))) {
        return line;
      }
    }

    return null;
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
      const [brand, model, name] = await Promise.all([
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.product.brand',
        ]),
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.product.model',
        ]),
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.product.name',
        ]),
      ]);
      const brandStr = brand.stdout.trim();
      const modelStr = model.stdout.trim();
      const nameStr = name.stdout.trim();
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
      const [deviceType, apiVersion, releaseType] = await Promise.all([
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.product.devicetype',
        ]),
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.ohos.apiversion',
        ]),
        this.executeHdc([
          '-t',
          serial,
          'shell',
          'param',
          'get',
          'const.ohos.releasetype',
        ]),
      ]);
      detail.deviceType = deviceType.stdout.trim();
      const apiVer = apiVersion.stdout.trim();
      const relType = releaseType.stdout.trim();
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

  public async installApp(
    packagePaths: string[],
    deviceSerial?: string
  ): Promise<void> {
    if (packagePaths.length === 0) {
      throw new Error('No packages to install');
    }

    const resolvedPaths = packagePaths.map((p) => {
      const resolved = path.resolve(p);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Application package not found: ${resolved}`);
      }
      return resolved;
    });

    for (let i = 0; i < resolvedPaths.length; i++) {
      const isLast = i === resolvedPaths.length - 1;
      const resolvedPath = resolvedPaths[i];

      if (isLast && resolvedPaths.length > 1) {
        console.log(cyan(`Installing main package: ${resolvedPath}`));
      } else if (resolvedPaths.length > 1) {
        console.log(
          cyan(`Installing dependency package (${i + 1}): ${resolvedPath}`)
        );
      } else {
        console.log(cyan(`Installing package: ${resolvedPath}`));
      }

      const args = deviceSerial
        ? ['-t', deviceSerial, 'install', '-r', resolvedPath]
        : ['install', '-r', resolvedPath];
      const { stdout, stderr } = await this.executeHdc(args);
      const failure = this.extractHdcFailure(`${stdout}\n${stderr}`);
      if (failure) {
        throw new Error(failure);
      }
    }
  }

  public async startApp(
    bundleName: string,
    ability: string,
    deviceSerial?: string
  ): Promise<void> {
    const args = deviceSerial
      ? [
          '-t',
          deviceSerial,
          'shell',
          'aa',
          'start',
          '-a',
          ability,
          '-b',
          bundleName,
        ]
      : ['shell', 'aa', 'start', '-a', ability, '-b', bundleName];
    const { stdout, stderr } = await this.executeHdc(args);
    const failure = this.extractHdcFailure(`${stdout}\n${stderr}`);
    if (failure) {
      throw new Error(failure);
    }
  }

  public async uninstallApp(
    bundleName: string,
    deviceSerial?: string
  ): Promise<void> {
    const args = deviceSerial
      ? ['-t', deviceSerial, 'uninstall', bundleName]
      : ['uninstall', bundleName];
    const { stdout, stderr } = await this.executeHdc(args);
    const failure = this.extractHdcFailure(`${stdout}\n${stderr}`);
    if (failure) {
      throw new Error(failure);
    }
  }
}

async function listAction(deviceManager: DeviceManager) {
  try {
    const devices = await deviceManager.listDevices();

    if (devices.length === 0) {
      console.log('  [Empty]');
    } else {
      for (const device of devices) {
        const modelName = await deviceManager.getDeviceModel(device.serial);
        console.log(`  ${modelName} [${device.serial}]`);
      }
    }
    console.log('');
  } catch (error) {
    console.error(red(`Failed to list devices: ${(error as Error).message}`));
    process.exit(1);
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

async function infoAction(deviceManager: DeviceManager, deviceSerial?: string) {
  try {
    if (!deviceSerial) {
      await checkMultiDevice(deviceManager, 'deveco device --info');
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
      red(`Failed to get device info: ${(error as Error).message}`)
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
        `deveco device --install ${packagePaths.join(' ')}`
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
        `deveco device --uninstall ${bundleName}`
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

interface DeviceOptions {
  target?: string;
  list?: boolean;
  info?: boolean;
  install?: string[];
  uninstall?: string;
  bundle?: string;
  ability?: string;
}

const deviceCommand = new Command('device')
  .description('Manage connected devices')
  .option('-t, --target <serial>', 'Target device serial number')
  .option('--list', 'List all connected devices')
  .option('--info', 'Show detailed device information')
  .option(
    '--install <packagePaths...>',
    'Install one or more packages (.hap / .hsp / .app)'
  )
  .option('--uninstall <bundleName>', 'Uninstall an application by bundle name')
  .option(
    '-b, --bundle <bundleName>',
    'Bundle name for launching the app after install'
  )
  .option(
    '-a, --ability <abilityName>',
    'Ability name for launching the app after install'
  )
  .action(async (options: DeviceOptions) => {
    let deviceManager: DeviceManager;
    try {
      deviceManager = await DeviceManager.new();
    } catch (error) {
      console.error(
        red(`Failed to initialize device manager: ${(error as Error).message}`)
      );
      process.exit(1);
      return;
    }

    if (options.list) {
      await listAction(deviceManager);
    } else if (options.info) {
      await infoAction(deviceManager, options.target);
    } else if (options.install) {
      await installAction(
        deviceManager,
        options.install,
        options.target,
        options.bundle,
        options.ability
      );
    } else if (options.uninstall) {
      await uninstallAction(deviceManager, options.uninstall, options.target);
    } else {
      deviceCommand.outputHelp();
    }
  });

export default deviceCommand;
