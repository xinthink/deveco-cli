/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import { Project } from '../utils/project.js';
import { ToolProvider } from '../utils/tool-provider.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { DeviceManager } from '../service/device-manager.js';

interface RunOptions {
  module?: string;
  device?: string;
  product?: string;
  ability?: string;
  uninstall?: boolean;
}

async function selectDevice(
  deviceManager: DeviceManager,
  deviceArg?: string
): Promise<string> {
  const devices = await deviceManager.listDevices();
  if (devices.length === 0) {
    throw new Error(
      'No active devices found. Please start an emulator or connect a physical device.'
    );
  }

  if (!deviceArg && devices.length > 1) {
    const named = await deviceManager.listDevicesWithName();
    throw new Error(
      'Multiple devices found. Please specify a target device using `--device <Name>` or `--device <ID>`.\nAvailable devices:\n' +
        named.map((d) => `  - ${d.name} (${d.serial})`).join('\n')
    );
  }

  const picked = await deviceManager.getDeviceInfo(devices, deviceArg);
  if (!picked) {
    throw new Error('No active devices found.');
  }
  if (!deviceArg) {
    const name = await deviceManager.getDeviceName(picked.serial);
    console.log(`Auto-selected device: ${name} (${picked.serial})`);
  }
  return picked.serial;
}

function identifyModule(project: Project, moduleArg?: string): string {
  if (moduleArg) {
    return moduleArg;
  }

  const runnableModules = project.profile.modules.filter((m) => {
    const type = project.getModuleType(m.name);
    return type === 'entry' || type === 'feature' || type === 'shared';
  });

  if (runnableModules.length === 1) {
    const selected = runnableModules[0].name;
    console.log(`Auto-selected module: ${selected}`);
    return selected;
  }

  throw new Error(
    `No module specified. Please specify a module using --module <name>.\nAvailable runnable modules:\n` +
      runnableModules.map((m) => `  - ${m.name}`).join('\n')
  );
}

function resolveArtifacts(
  project: Project,
  moduleName: string,
  targetName: string,
  isEmulator: boolean,
  productName: string
): string[] {
  const artifactsToInstall: string[] = [];
  const hspModules = new Set<string>();
  project.resolveHspDependencies(moduleName, hspModules);

  for (const hsp of hspModules) {
    const p = project.findArtifactPath(
      hsp,
      targetName,
      isEmulator,
      productName
    );
    artifactsToInstall.push(p);
  }

  const mainHapPath = project.findArtifactPath(
    moduleName,
    targetName,
    isEmulator,
    productName
  );
  artifactsToInstall.push(mainHapPath);

  return artifactsToInstall;
}

async function performDeployment(
  hdcAdapter: HdcAdapter,
  targetDeviceId: string,
  bundleName: string,
  artifactsToInstall: string[],
  mainAbility: string,
  uninstall: boolean
): Promise<void> {
  if (uninstall) {
    console.log(`Uninstalling ${bundleName}...`);
    const uninstalled = await hdcAdapter.uninstallApp(
      targetDeviceId,
      bundleName
    );
    if (!uninstalled) {
      console.log(`App ${bundleName} is not installed, skipping uninstall.`);
    }
  }

  console.log(`\nInstalling artifacts to device ${targetDeviceId}...`);
  await hdcAdapter.installApp(targetDeviceId, artifactsToInstall);

  console.log(`Launching ${bundleName}/${mainAbility}...`);
  const launchResult = await hdcAdapter.launchApp(
    targetDeviceId,
    bundleName,
    mainAbility
  );
  console.log(green(`\nApplication '${bundleName}': ${launchResult}`));
}

const runCommand = new Command('run')
  .description('Build and run the project on a connected device')
  .option(
    '--module <module>',
    'Module to run (format: module or module@target)'
  )
  .option('--device <device>', 'Target device name or serial')
  .option('--product <product>', 'Product name (default: default)')
  .option('--ability <ability>', 'Ability name to launch')
  .option('--uninstall', 'Uninstall existing app before installation')
  .action(async (options: RunOptions) => {
    try {
      await runActionImpl(options);
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

async function runActionImpl(options: RunOptions): Promise<void> {
  const project = Project.discover(process.cwd());
  const toolProvider = await ToolProvider.new();
  const moduleArg = identifyModule(project, options.module);
  const splitIndex = moduleArg.indexOf('@');
  const moduleName =
    splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
  const targetName =
    splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : 'default';

  const type = project.getModuleType(moduleName);
  if (type !== 'entry' && type !== 'feature' && type !== 'shared') {
    throw new Error(
      `Module '${moduleName}' is of type '${type}', which is not runnable. Please specify an entry or feature module.`
    );
  }

  const hdcAdapter = new HdcAdapter(toolProvider);
  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);
  const isEmulator =
    targetDeviceId.includes('127.0.0.1') ||
    targetDeviceId.includes('localhost');
  const productName = options.product || 'default';

  const artifactsToInstall = resolveArtifacts(
    project,
    moduleName,
    targetName,
    isEmulator,
    productName
  );
  const bundleName = project.getBundleName();
  const mainAbility = project.getMainAbility(moduleName, options.ability);

  await performDeployment(
    hdcAdapter,
    targetDeviceId,
    bundleName,
    artifactsToInstall,
    mainAbility,
    !!options.uninstall
  );
}

export default runCommand;
