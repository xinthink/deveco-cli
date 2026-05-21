/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import { Project } from '../utils/project.js';
import { ToolProvider } from '../utils/tool-provider.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { withBuildLock } from '../utils/build-lock.js';

interface BuildOptions {
  product?: string;
  modules?: string[];
  buildMode?: string;
}

function validateProjectConfig(project: Project, options: BuildOptions) {
  // Validate product
  if (options.product) {
    const found = project.profile.app.products.some(
      (p) => p.name === options.product
    );
    if (!found) {
      throw new Error(
        `Product '${options.product}' not found in project build-profile.json5.`
      );
    }
  }

  // Validate build mode
  if (options.buildMode) {
    const found = project.profile.app.buildModeSet.some(
      (m) => m.name === options.buildMode
    );
    if (!found) {
      throw new Error(
        `Build mode '${options.buildMode}' not found in project build-profile.json5.`
      );
    }
  }
}

function determineModulesToBuild(
  project: Project,
  options: BuildOptions
): string[] {
  let initialModules: string[];

  if (options.modules && options.modules.length > 0) {
    initialModules = options.modules;
  } else {
    // Default behavior: find entry module or the only module
    const allModules = project.profile.modules;
    const entryModules = allModules.filter((m) => {
      const type = project.getModuleType(m.name);
      return type === 'entry';
    });

    if (allModules.length === 1) {
      initialModules = [allModules[0].name];
    } else if (entryModules.length === 1) {
      initialModules = [entryModules[0].name];
    } else if (entryModules.length > 1) {
      throw new Error(
        `Multiple entry modules found (${entryModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`
      );
    } else {
      throw new Error(
        `No entry module found and multiple modules available (${allModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`
      );
    }
  }

  // Resolve HSP dependencies for each initial module
  const finalModulesSet = new Set<string>();
  for (const moduleArg of initialModules) {
    const splitIndex = moduleArg.indexOf('@');
    const moduleName =
      splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
    const targetName =
      splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : 'default';
    finalModulesSet.add(`${moduleName}@${targetName}`);
  }

  return Array.from(finalModulesSet);
}

export function processModuleTasks(
  project: Project,
  modulesToBuild: string[]
): Set<string> {
  const moduleTasks = new Set<string>();

  for (const moduleArg of modulesToBuild) {
    const splitIndex = moduleArg.indexOf('@');
    const moduleName =
      splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;

    // Determine module type and required task
    const moduleType = project.getModuleType(moduleName);
    if (moduleType === 'shared') {
      moduleTasks.add('assembleHsp');
    } else if (moduleType === 'har') {
      moduleTasks.add('assembleHar');
    } else {
      moduleTasks.add('assembleHap');
    }
  }

  return moduleTasks;
}

type ToolRunError = Error & { stdout?: string; stderr?: string };

export function logAdapterFailureAndThrow(stepLabel: string, error: unknown): never {
  const e = error as ToolRunError;
  const failMsg = `${stepLabel} failed`;
  console.error(red(failMsg));
  const errText = e.stdout || e.message;
  if (errText) {
    console.error(errText);
  }
  if (e.stderr) {
    console.error(e.stderr);
  }
  throw new Error(failMsg, { cause: error });
}

export type BuildTarget =
  | { type: 'product' }
  | { type: 'modules'; modulesToBuild: string[]; moduleTasks: Set<string> };

export async function executeBuildSteps(
  ohpmAdapter: OhpmAdapter,
  hvigorAdapter: HvigorAdapter,
  productName: string,
  buildMode: string,
  buildTarget: BuildTarget
) {
  console.log('\n[1/3] Running ohpm install...');
  try {
    await ohpmAdapter.installAll();
  } catch (error) {
    logAdapterFailureAndThrow('ohpm install', error);
  }

  console.log('\n[2/3] Running hvigor sync...');
  try {
    await hvigorAdapter.sync(productName, buildMode);
  } catch (error) {
    logAdapterFailureAndThrow('hvigor sync', error);
  }

  console.log('\n[3/3] Running hvigor build...');
  try {
    if (buildTarget.type === 'product') {
      await hvigorAdapter.buildProduct(productName, buildMode);
    } else {
      await hvigorAdapter.buildModules(
        productName,
        buildMode,
        buildTarget.modulesToBuild,
        buildTarget.moduleTasks
      );
    }
  } catch (error) {
    logAdapterFailureAndThrow('hvigor build', error);
  }
}

const buildCommand = new Command('build')
  .description('Build the HarmonyOS project')
  .option(
    '--product <product>',
    'Product name defined in build-profile.json5 (default: default)'
  )
  .option(
    '--modules <modules...>',
    'Modules to build (format: module or module@target)'
  )
  .option(
    '--build-mode <mode>',
    'Build mode (buildModeSet in build-profile.json5; e.g. debug, release; default: debug)'
  )
  .action(async (options: BuildOptions) => {
    try {
      const currentDir = process.cwd();
      const project = Project.discover(currentDir);

      const toolProvider = await ToolProvider.new();

      validateProjectConfig(project, options);

      const productName = options.product || 'default';
      const buildMode = options.buildMode || 'debug';

      let buildTarget:
        | { type: 'product' }
        | {
            type: 'modules';
            modulesToBuild: string[];
            moduleTasks: Set<string>;
          };

      if (options.product && !options.modules) {
        // If product is specified without modules, build the whole product
        buildTarget = { type: 'product' };
      } else {
        // Build specific modules or auto-detect modules
        const modulesToBuild = determineModulesToBuild(project, options);
        const moduleTasks = processModuleTasks(project, modulesToBuild);
        buildTarget = { type: 'modules', modulesToBuild, moduleTasks };
      }

      const ohpmAdapter = new OhpmAdapter(toolProvider, project.rootDir);
      const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);

      await withBuildLock(
        project.rootDir,
        async () =>
          executeBuildSteps(
            ohpmAdapter,
            hvigorAdapter,
            productName,
            buildMode,
            buildTarget
          ),
        () => {
          console.log(
            'Another build is already running for this project. Waiting for it to finish...'
          );
        }
      );

      console.log('\n' + green('Build completed successfully!'));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

buildCommand
  .command('clean')
  .description('Clean the HarmonyOS project build outputs')
  .action(async () => {
    try {
      const currentDir = process.cwd();
      const project = Project.discover(currentDir);

      const toolProvider = await ToolProvider.new();

      const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);
      await withBuildLock(
        project.rootDir,
        async () => {
          console.log('\n[1/2] Running hvigor clean...');
          try {
            await hvigorAdapter.clean();
          } catch (error) {
            logAdapterFailureAndThrow('hvigor clean', error);
          }

          console.log('\n[2/2] Running hvigor --stop-daemon...');
          try {
            await hvigorAdapter.stopDaemon();
          } catch (error) {
            logAdapterFailureAndThrow('hvigor --stop-daemon', error);
          }
        },
        () => {
          console.log(
            'Another build is already running for this project. Waiting for it to finish...'
          );
        }
      );

      console.log('\n' + green('Clean completed successfully!'));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default buildCommand;
