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
  if (options.modules) {
    return options.modules;
  }

  // Default behavior: find entry module or the only module
  const allModules = project.profile.modules;
  const entryModules = allModules.filter((m) => {
    const type = project.getModuleType(m.name);
    return type === 'entry';
  });

  if (allModules.length === 1) {
    // Only one module, build it
    return [allModules[0].name];
  } else if (entryModules.length === 1) {
    // Exactly one entry module, build it
    return [entryModules[0].name];
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

function processModuleTasks(
  project: Project,
  modulesToBuild: string[]
): Set<string> {
  const moduleTasks = new Set<string>();

  for (const moduleArg of modulesToBuild) {
    const splitIndex = moduleArg.indexOf('@');
    const moduleName =
      splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
    const targetName =
      splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : null;

    // Check if module exists
    const moduleProfile = project.getModuleProfile(moduleName);

    // Check if target exists (if specified)
    if (targetName) {
      const found = moduleProfile.targets.some((t) => t.name === targetName);
      if (!found) {
        throw new Error(
          `Target '${targetName}' not found for module '${moduleName}' in its build-profile.json5.`
        );
      }
    }

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

async function executeBuildSteps(
  ohpmAdapter: OhpmAdapter,
  hvigorAdapter: HvigorAdapter,
  productName: string,
  buildMode: string,
  buildTarget:
    | { type: 'product' }
    | { type: 'modules'; modulesToBuild: string[]; moduleTasks: Set<string> }
) {
  // Step 1: ohpm install --all
  console.log('\n[1/3] Running ohpm install...');
  try {
    await ohpmAdapter.installAll();
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    console.log(red('ohpm install failed'));
    console.error(e.stdout || e.message);
    console.error(e.stderr);
    throw new Error('ohpm install failed', { cause: error });
  }

  // Step 2: hvigor --sync
  console.log('\n[2/3] Running hvigor sync...');
  try {
    await hvigorAdapter.sync(productName, buildMode);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    console.log(red('hvigor sync failed'));
    console.error(e.stdout || e.message);
    console.error(e.stderr);
    throw new Error('hvigor sync failed', { cause: error });
  }

  // Step 3: hvigor build
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
    const e = error as Error & { stdout?: string; stderr?: string };
    console.log(red('hvigor build failed'));
    console.error(e.stdout || e.message);
    console.error(e.stderr);
    throw new Error('hvigor build failed', { cause: error });
  }
}

const buildCommand = new Command('build')
  .description('Build HarmonyOS project')
  .option('--product <product>', 'Product to build')
  .option(
    '--modules <modules...>',
    'Modules to build. Format: module or module@target'
  )
  .option('--buildMode <buildMode>', 'Build mode (e.g., debug, release)')
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

      await executeBuildSteps(
        ohpmAdapter,
        hvigorAdapter,
        productName,
        buildMode,
        buildTarget
      );

      console.log('\n' + green('Build completed successfully!'));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default buildCommand;
