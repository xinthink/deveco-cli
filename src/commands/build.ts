/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, yellow } from 'colorette';
import { Project } from '../utils/project.js';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { withBuildLock } from '../utils/build-lock.js';
import { checkSyncRequired } from '../utils/project-check.js';
import { findCppModules, findAndMergeCompileCommands } from '../../mcp/src-server/lsp/sync/cpp-compile.js';

interface BuildOptions {
  product?: string;
  modules?: string[];
  buildMode?: string;
}

function validateProjectConfig(project: Project, options: BuildOptions) {
  // Validate product
  if (options.product) {
    project.validateProduct(options.product);
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

function validateRequestedModules(project: Project, modules: string[]) {
  const availableModules = project.profile.modules.map((module) => module.name);
  const availableModuleSet = new Set(availableModules);

  for (const moduleArg of modules) {
    const moduleName = moduleArg.split('@', 1)[0];
    if (!availableModuleSet.has(moduleName)) {
      throw new Error(
        `Module '${moduleName}' not found in project-level build-profile.json5. ` +
          `Available modules: ${availableModules.join(', ') || 'none'}`
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
    validateRequestedModules(project, initialModules);
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
  buildTarget: BuildTarget,
  projectRoot: string
) {
  // ohpm install always runs; hvigor sync is skipped when configurations are unchanged
  const checkResult = checkSyncRequired(projectRoot);

  console.log('\n[ohpm install] Running...');
  try {
    await ohpmAdapter.installAll();
  } catch (error) {
    logAdapterFailureAndThrow('ohpm install', error);
  }

  if (checkResult.required) {
    console.log('\n[hvigor sync] Running...');
    try {
      await hvigorAdapter.sync(productName, buildMode);
    } catch (error) {
      logAdapterFailureAndThrow('hvigor sync', error);
    }
  } else {
    console.log('\n[hvigor sync] Skipped (configurations unchanged)');
  }

  console.log('\n[hvigor build] Running...');
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

  // 构建成功后合并中央 compile_commands.json（供 clangd 使用）。
  mergeCppCompileCommands(projectRoot);
}

/**
 * 构建成功后，若工程含 C++ 模块，合并各模块 .cxx 下的 compile_commands.json 到中央文件
 * （.idea/.deveco/cxx/compile_commands.json），供 devecocli serve lsp --cpp / MCP 的 clangd 使用。
 * assembleHap 已为被构建的 C++ 模块生成每模块 compile_commands.json，此处只需合并，不重复跑
 * compileNative。非 C++ 工程或合并失败时静默跳过，不影响构建产物。
 */
function mergeCppCompileCommands(projectRoot: string): void {
  try {
    const cppModules = findCppModules(projectRoot);
    if (cppModules.length === 0) {
      return;
    }
    findAndMergeCompileCommands(projectRoot);
    console.log(green('\nMerged central compile_commands.json for C++ language server.'));
  } catch (e) {
    console.warn(yellow(`\nFailed to merge compile_commands.json: ${(e as Error).message}`));
  }
}

const buildCommand = new Command('build')
  .description('Build HarmonyOS project')
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
      console.warn(yellow('Ensure the project source is trustworthy before proceeding.'));

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

      const toolProvider = await ToolProvider.new();
      toolProvider.assertJava();

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
            buildTarget,
            project.rootDir
          ),
        () => {
          console.log(
            'Another build is already running for this project. Waiting for completion...'
          );
        }
      );

      console.log('\n' + green('Build completed successfully'));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

buildCommand
  .command('clean')
  .description('Clean HarmonyOS project build outputs')
  .action(async () => {
    try {
      const currentDir = process.cwd();
      const project = Project.discover(currentDir);
      console.warn(yellow('Ensure the project source is trusted before proceeding.'));
      const toolProvider = await ToolProvider.new();
      toolProvider.assertJava();

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

      console.log('\n' + green('Clean completed successfully.'));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default buildCommand;
