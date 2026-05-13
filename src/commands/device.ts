/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { ToolProvider } from '../utils/tool-provider.js';
import { red, yellow, gray } from 'colorette';

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
        `Device "${deviceSelector}" not found. Use \`deveco device list\` to see available targets.`
      );
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
      await checkMultiDevice(deviceManager, 'deveco device view');
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

async function initDeviceManager(): Promise<DeviceManager> {
  try {
    const toolProvider = await ToolProvider.new();
    return DeviceManager.from(toolProvider);
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
    const deviceManager = await initDeviceManager();
    await listAction(deviceManager);
  });

deviceCommand
  .command('view')
  .description('Show detailed device information')
  .option('-t, --target <serialOrName>', 'Target device serial or device name')
  .action(async (options: { target?: string }) => {
    const deviceManager = await initDeviceManager();
    await viewAction(deviceManager, options.target);
  });

export default deviceCommand;
