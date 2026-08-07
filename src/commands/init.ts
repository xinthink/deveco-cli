/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { red, cyan } from 'colorette';
import {
  installLocalSkillToAgent,
  installLocalSkillToProjectAgent,
  installLocalSkillToPath,
  resolveBundledSkillMdPath,
} from '../skills/installer';
import {
  summarizeOperationResults,
  validatePathMutex,
  validateDirectoryPath,
  resolveInstallationTargets,
} from '../skills/agents';
import {
  installMcpConfigToAgentGlobal,
  installMcpConfigToAgentProject,
  summarizeMcpResults,
} from '../skills/mcp-installer';
import { AGENT_MCP_CONFIG } from '../config/mcp';
import {
  InitOptions,
  SkillOperationResult,
  type InstallationTargets,
} from '../types/skills';
import {
  telemetry,
  EventType,
  type McpConfigOperation,
  type SkillConfigOperation,
  type TrackMeasurement,
} from '../trace/index.js';

const DEVECO_CLI_SKILL_NAME = 'deveco-cli';

async function executeSkillInstallations(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  sourceFile: string,
  options: InitOptions
): Promise<SkillOperationResult[]> {
  if (targets.customPath) {
    return [await installLocalSkillToPath(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      targets.customPath,
      options.force
    )];
  }

  const tasks: (() => Promise<SkillOperationResult>)[] = [
    ...targets.projectAgents.map(({ project, agent }) => () =>
      installLocalSkillToProjectAgent(DEVECO_CLI_SKILL_NAME, sourceFile, project, agent, options.force)
    ),
    ...targets.agents.map((agentName) => () =>
      installLocalSkillToAgent(DEVECO_CLI_SKILL_NAME, sourceFile, agentName, options.force)
    ),
  ];

  const concurrencyLimit = 5;
  const results: SkillOperationResult[] = [];
  for (let i = 0; i < tasks.length; i += concurrencyLimit) {
    const batch = tasks.slice(i, i + concurrencyLimit);
    results.push(...(await Promise.all(batch.map((fn) => fn()))));
  }
  return results;
}

function resolveTraceAgents(targets: InstallationTargets): string[] {
  return [
    ...new Set([
      ...targets.agents,
      ...targets.projectAgents.map(({ agent }) => agent),
    ]),
  ];
}

async function recordSkillConfigEvent(
  event: SkillConfigOperation,
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  await telemetry
    .track(event, {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    })
    .catch(() => {});
}

async function trackSkillConfigInstall(
  targets: InstallationTargets,
  sourceFile: string,
  options: InitOptions,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<SkillOperationResult[]> {
  const event: SkillConfigOperation = {
    event: EventType.SkillConfigOperation,
    subAction: 'install',
    targetType: resolvedPath ? 'path' : resolvedProject ? 'project' : 'global',
    agents: resolveTraceAgents(targets),
  };
  const start = Date.now();
  try {
    const results = await executeSkillInstallations(
      targets,
      sourceFile,
      options
    );
    const success = results.every((result) => result.success || result.skipped);
    await recordSkillConfigEvent(
      event,
      start,
      success,
      success ? null : 'SKILL_INSTALL_FAILED'
    );
    return results;
  } catch (error) {
    const errorCode =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.name)
        : 'UnknownError';
    await recordSkillConfigEvent(event, start, false, errorCode);
    throw error;
  }
}

/**
 * 项目级 MCP 安装：对 targets 中所有 agent 安装项目级配置
 */
async function installProjectLevelMcp(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string,
  force: boolean
): Promise<Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] = [];

  for (const { project, agent } of targets.projectAgents) {
    const result = await installMcpConfigToAgentProject(agent, project, force);
    results.push(result);
  }
  for (const agentName of targets.agents) {
    const result = await installMcpConfigToAgentProject(agentName, resolvedProject, force);
    results.push(result);
  }
  return results;
}

/**
 * 全局 MCP 安装：给所有 agent 配置全局 MCP
 */
async function installGlobalMcp(
  agentNames: string[],
  force: boolean
): Promise<Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] = [];
  for (const agentName of agentNames) {
    const agentConfig = AGENT_MCP_CONFIG[agentName];
    if (!agentConfig) {
      continue;
    }
    const result = await installMcpConfigToAgentGlobal(agentName, process.cwd(), force);
    results.push(result);
  }
  return results;
}

/**
 * 执行 MCP 配置安装（仅 --mcp 时触发）
 *
 * 场景逻辑：
 * 1. devecocli init --mcp             → 全局 MCP（所有 agent 写入各自全局目录）
 * 2. devecocli init --mcp --project   → 项目级 MCP（所有 agent 写入各自项目目录）
 * 3. devecocli init --mcp --force     → 全局 MCP + 覆盖已有配置
 * --force 只改变覆盖行为，不改变全局/项目级模式。
 */
async function executeMcpInstallations(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string | undefined,
  options: InitOptions
): Promise<void> {
  // 只有用户明确指定 --agent qoder 时才报错
  if (options.agent) {
    const specifiedAgents = options.agent.split(',').map(a => a.trim());
    if (specifiedAgents.includes('qoder')) {
      throw new Error('Qoder does not support MCP configuration via DevEco CLI. Use other supported agents instead.');
    }
  }

  const force = options.force ?? false;

  // 过滤掉 qoder，不对其进行 MCP 配置
  const filteredProjectAgents = targets.projectAgents.filter(p => p.agent !== 'qoder');
  const filteredAgents = targets.agents.filter(a => a !== 'qoder');

  const filteredTargets = {
    ...targets,
    projectAgents: filteredProjectAgents,
    agents: filteredAgents,
  };

  const mcpResults = resolvedProject
    ? await installProjectLevelMcp(filteredTargets, resolvedProject, force)
    : await installGlobalMcp(filteredTargets.agents, force);

  if (mcpResults.length > 0) {
    console.log(cyan('MCP Configuration:'));
    summarizeMcpResults(mcpResults);
  }
}

/**
 * 执行 MCP 配置安装并打点 devecocli_mcp_config_operation（action=install）。
 * 用 §3.3 手动测量重载记录耗时与成败：executeMcpInstallations 抛错时记
 * success=false + error_code（之前写死 success=true 是 bug），再 rethrow。
 */
async function trackMcpConfigInstall(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string | undefined,
  options: InitOptions,
): Promise<void> {
  const mcpEvent: McpConfigOperation = {
    event: EventType.Init,
    subAction: 'install',
    targetType: resolvedProject ? 'project' : 'global',
    agentName: options.agent,
  };
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await executeMcpInstallations(targets, resolvedProject, options);
  } catch (e) {
    success = false;
    errorCode =
      e instanceof Error
        ? (e as NodeJS.ErrnoException).code ?? e.name
        : 'UnknownError';
    throw e;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(mcpEvent, measurement);
  }
}

/**
 * devecocli init 入口
 * - 不带标志 / --skill：只安装 skill
 * - 带 --mcp：只配置 MCP（不安装 skill）
 * - --skill 和 --mcp 互斥
 */
async function handleInitCommand(options: InitOptions): Promise<void> {
  // --skill 和 --mcp 互斥
  if (options.skill && options.mcp) {
    throw new Error('Cannot use `--skill` and `--mcp` together. Use `--skill` for skill installation only, or `--mcp` for MCP configuration only.');
  }

  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );

  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory', options.force);
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory', options.force);
  }

  const targets = await resolveInstallationTargets(
    options,
    resolvedPath,
    resolvedProject
  );

  // --mcp 时只配置 MCP，不安装 skill
  if (options.mcp) {
    await trackMcpConfigInstall(targets, resolvedProject, options);
    return;
  }

  // 默认或 --skill：只安装 skill
  const sourceFile = resolveBundledSkillMdPath();
  const skillResults = await trackSkillConfigInstall(
    targets,
    sourceFile,
    options,
    resolvedPath,
    resolvedProject
  );

  console.log();
  if (skillResults.length > 0) {
    console.log(cyan('Skill Installation:'));
    summarizeOperationResults(skillResults);
  }
}

const initCommand = new Command('init')
  .description('Install the deveco-cli skill or configure the deveco-mcp server into AI agents')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated; installs to all available agents if omitted'
  )
  .option(
    '--project <path>',
    'Project root directory for skill or MCP configuration'
  )
  .option(
    '--path <path>',
    'Path to install the skill directly (cannot be used with --project or --agent)'
  )
  .option(
    '--skill',
    'Install the deveco-cli skill only (same as default behavior; explicit for symmetry with --mcp)'
  )
  .option(
    '--mcp',
    'Configure the deveco-mcp server (syntax checking for .ets and C/C++) only; no skill installation'
  )
  .option('-f, --force', 'Overwrite existing skill/MCP configuration')
  .action(async (options: InitOptions) => {
    try {
      await handleInitCommand(options);
    } catch (error: unknown) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

export default initCommand;
