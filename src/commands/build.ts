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
import { telemetry, EventType, toTraceErrorCode, type CommandExecuted, type TrackMeasurement, TraceError } from '../trace/index.js';

interface BuildOptions {
  product?: string;
  modules?: string[];
  buildMode?: string;
}

interface BuildResult {
  bundleName: string;
  ohpmMemoryMb: string;
  syncMemoryMb: string;
  buildMemoryMb: string;
}

function validateProjectConfig(project: Project, options: BuildOptions) {
  // Validate product
  if (options.product) {
    project.validateProduct(options.product);
  }

  // Validate build mode
  if (options.buildMode) {
    const defaultModes = ['debug', 'release'];
    const customModes = (project.profile.app.buildModeSet?.map((m) => m.name) ?? [])
      .filter((m) => !defaultModes.includes(m));
    const allModes = [...defaultModes, ...customModes];
    if (!allModes.includes(options.buildMode)) {
      throw new Error(
        `Build mode '${options.buildMode}' not found. Available modes: ${allModes.join(', ')}`
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
      throw new TraceError(
        `Multiple entry modules found (${entryModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`,
        'Multiple entry modules found.'
      );
    } else {
      throw new TraceError(
        `No entry module found and multiple modules available (${allModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`,
        'No entry module found and multiple modules available.'
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
): Promise<{ ohpmMemoryMb: string; syncMemoryMb: string; buildMemoryMb: string }> {
  // ohpm install always runs; hvigor sync is skipped when configurations are unchanged
  const checkResult = checkSyncRequired(projectRoot);

  console.log('\n[ohpm install] Running...');
  try {
    await ohpmAdapter.installAll();
  } catch (error) {
    logAdapterFailureAndThrow('ohpm install', error);
  }

  let syncMemoryMb = '';
  if (checkResult.required) {
    console.log('\n[hvigor sync] Running...');
    try {
      syncMemoryMb = await hvigorAdapter.sync(productName, buildMode);
    } catch (error) {
      logAdapterFailureAndThrow('hvigor sync', error);
    }
  } else {
    console.log('\n[hvigor sync] Skipped (configurations unchanged)');
  }

  console.log('\n[hvigor build] Running...');
  let buildMemoryMb = '';
  try {
    if (buildTarget.type === 'product') {
      buildMemoryMb = await hvigorAdapter.buildProduct(productName, buildMode);
    } else {
      buildMemoryMb = await hvigorAdapter.buildModules(
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
  return { ohpmMemoryMb: ohpmAdapter.peakMemoryMb, syncMemoryMb, buildMemoryMb };
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

async function withTrace(
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

function buildBuildEvent(options: BuildOptions): CommandExecuted {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: [
      'build',
      ...(options.product ? ['--product'] : []),
      ...(options.modules ? ['--modules'] : []),
      ...(options.buildMode ? ['--build-mode'] : []),
    ],
  };
  if (options.buildMode) {
    event.build_mode = options.buildMode;
  }
  if (options.modules) {
    event.module_count = options.modules.length;
  }
  return event;
}

function buildCleanEvent(): CommandExecuted {
  return {
    event: EventType.CommandExecuted,
    args: ['build', 'clean'],
  };
}

async function handleBuild(
  options: BuildOptions
): Promise<BuildResult> {
  const currentDir = process.cwd();
  const project = Project.discover(currentDir);
  console.warn(yellow('Ensure the project source is trustworthy before proceeding.'));
  const toolProvider = await ToolProvider.new();
  toolProvider.assertJava();

  validateProjectConfig(project, options);

  const productName = options.product || 'default';
  const buildMode = options.buildMode || 'debug';

  let buildTarget:
    | { type: 'product' }
    | { type: 'modules'; modulesToBuild: string[]; moduleTasks: Set<string> };

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

  const memStats = await withBuildLock(
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
  return {
    bundleName: project.getBundleName(),
    ohpmMemoryMb: memStats.ohpmMemoryMb,
    syncMemoryMb: memStats.syncMemoryMb,
    buildMemoryMb: memStats.buildMemoryMb,
  };
}

async function handleClean(): Promise<string> {
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
  return project.getBundleName();
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
    const event = buildBuildEvent(options);
    await withTrace(event, async () => {
      const result = await handleBuild(options);
      event.bundle_name = result.bundleName;
      if (result.ohpmMemoryMb) {
        event.ohpm_install_memory = result.ohpmMemoryMb;
      }
      if (result.syncMemoryMb) {
        event.hvigor_sync_memory = result.syncMemoryMb;
      }
      if (result.buildMemoryMb) {
        event.hvigor_build_memory = result.buildMemoryMb;
      }
    });
  });

buildCommand
  .command('clean')
  .description('Clean HarmonyOS project build outputs')
  .action(async () => {
    const event = buildCleanEvent();
    await withTrace(event, async () => {
      event.bundle_name = await handleClean();
    });
  });

export default buildCommand;
