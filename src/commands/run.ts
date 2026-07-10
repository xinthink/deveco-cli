/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, yellow } from 'colorette';
import { Project } from '../utils/project.js';
import { ToolProvider } from '../utils/tool-provider.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { DeviceManager } from '../service/device-manager.js';
import { withBuildLock } from '../utils/build-lock.js';
import { executeBuildSteps, processModuleTasks } from './build.js';

interface RunOptions {
  module?: string[];
  device?: string;
  product?: string;
  buildMode?: string;
  ability?: string;
  uninstall?: boolean;
  skipBuild?: boolean;
}

function parseModuleArg(moduleArg: string): { moduleName: string; targetName: string } {
  const splitIndex = moduleArg.indexOf('@');
  const moduleName = splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
  const targetName = splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : 'default';
  return { moduleName, targetName };
}

async function selectDevice(
  deviceManager: DeviceManager,
  deviceArg?: string
): Promise<string> {
  const devices = await deviceManager.listDevices();
  if (devices.length === 0) {
    throw new Error(
      'No active devices found. Start an emulator or connect a physical device.'
    );
  }

  if (!deviceArg && devices.length > 1) {
    const named = await deviceManager.listDevicesWithName();
    throw new Error(
      'Multiple devices found. Specify a target device using `--device <Name>` or `--device <ID>`.\nAvailable devices:\n' +
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

function identifyModules(project: Project, moduleArgs?: string[]): string[] {
  if (moduleArgs && moduleArgs.length > 0) {
    return moduleArgs;
  }

  const runnableModules = project.profile.modules.filter((m) => {
    const type = project.getModuleType(m.name);
    return type === 'entry' || type === 'feature' || type === 'shared';
  });

  if (runnableModules.length === 1) {
    const selected = runnableModules[0].name;
    console.log(`Auto-selected module: ${selected}`);
    return [selected];
  }

  throw new Error(`Specify module(s) using --module <name> [<name>...].\nAvailable runnable modules:\n` +
      runnableModules.map((m) => `  - ${m.name}`).join('\n')
  );
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
      console.log(`App ${bundleName} not installed; skipping uninstallation.`);
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
    '--module <modules...>',
    'Module(s) to run (format: module or module@target)'
  )
  .option('--device <device>', 'Target device name or serial')
  .option('--product <product>', 'Product name (default: default)')
  .option('--build-mode <mode>', 'Build mode (options: debug, release; default: debug)')
  .option('--ability <ability>', 'Ability name to launch')
  .option('--uninstall', 'Uninstall existing app before installation')
  .option('--skip-build', 'Skip build step and deploy existing artifacts')
  .action(async (options: RunOptions) => {
    try {
      await runActionImpl(options);
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

async function runBuildPhase(
  project: Project,
  toolProvider: ToolProvider,
  parsedModules: { moduleName: string; targetName: string }[],
  productName: string,
  buildMode: string
): Promise<void> {
  const ohpmAdapter = new OhpmAdapter(toolProvider, project.rootDir);
  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);

  const moduleSet = new Set<string>();
  for (const { moduleName, targetName } of parsedModules) {
    for (const m of project.collectNonHarDependentModuleList(moduleName)) {
      moduleSet.add(`${m}@${targetName}`);
    }
  }
  const modulesToBuild = [...moduleSet];
  const moduleTasks = processModuleTasks(project, modulesToBuild);
  const buildTarget = { type: 'modules' as const, modulesToBuild, moduleTasks };

  await withBuildLock(
    project.rootDir,
    () => executeBuildSteps(ohpmAdapter, hvigorAdapter, productName, buildMode, buildTarget),
    () => console.log('Another build is already running for this project. Waiting for completion...')
  );

  console.log('\n' + green('Build completed successfully.'));
}

async function runActionImpl(options: RunOptions): Promise<void> {
  const project = Project.discover(process.cwd());
  console.warn(yellow('Ensure the project source is trusted before proceeding.'));
  const toolProvider = await ToolProvider.new();

  const moduleArgs = identifyModules(project, options.module);
  const parsedModules = moduleArgs.map(parseModuleArg);

  for (const { moduleName } of parsedModules) {
    const type = project.getModuleType(moduleName);
    if (type !== 'entry' && type !== 'feature' && type !== 'shared') {
      throw new Error(
        `Module '${moduleName}' '${type}' is not runnable. Specify an entry or feature module.`
      );
    }
  }

  const hdcAdapter = new HdcAdapter(toolProvider);
  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);
  const isEmulator =
    targetDeviceId.includes('127.0.0.1') ||
    targetDeviceId.includes('localhost');

  const productName = options.product || 'default';
  project.validateProduct(productName);
  const buildMode = options.buildMode || 'debug';

  if (!options.skipBuild) {
    await runBuildPhase(project, toolProvider, parsedModules, productName, buildMode);
  }

  const artifactSet = new Set<string>();
  for (const { moduleName, targetName } of parsedModules) {
    const nonHarModules = project.collectNonHarDependentModuleList(moduleName);
    for (const hsp of nonHarModules) {
      artifactSet.add(project.findArtifactPath(hsp, targetName, isEmulator, productName));
    }
    artifactSet.add(project.findArtifactPath(moduleName, targetName, isEmulator, productName));
  }
  const allArtifacts = [...artifactSet];

  const bundleName = project.getBundleName();
  const mainAbility = project.getMainAbility(parsedModules[0].moduleName, options.ability);

  await performDeployment(
    hdcAdapter,
    targetDeviceId,
    bundleName,
    allArtifacts,
    mainAbility,
    !!options.uninstall
  );
}

export default runCommand;
