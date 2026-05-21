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
import { AGENT_MCP_CONFIG, GLOBAL_MCP_AGENTS } from '../config/mcp';
import { InitOptions, SkillOperationResult } from '../types/skills';
import { ToolProvider } from '../utils/tool-provider';

const DEVECO_CLI_SKILL_NAME = 'deveco-cli';

async function executeSkillInstallations(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  sourceFile: string,
  options: InitOptions
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];

  if (targets.customPath) {
    const result = await installLocalSkillToPath(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      targets.customPath,
      options.force
    );
    results.push(result);
    return results;
  }

  for (const { project, agent } of targets.projectAgents) {
    const result = await installLocalSkillToProjectAgent(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      project,
      agent,
      options.force
    );
    results.push(result);
  }

  for (const agentName of targets.agents) {
    const result = await installLocalSkillToAgent(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      agentName,
      options.force
    );
    results.push(result);
  }

  return results;
}

/**
 * 获取 DevEco Studio 路径（未安装时返回 undefined）
 */
async function resolveDevecoPath(): Promise<string | undefined> {
  try {
    const toolProvider = await ToolProvider.new();
    return toolProvider.devecoStudioPath;
  } catch {
    return undefined;
  }
}

/**
 * 项目级 MCP 安装：对 targets 中所有 agent 安装项目级配置
 */
async function installProjectLevelMcp(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string,
  devecoPath: string | undefined,
  force: boolean
): Promise<Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] = [];
  for (const { project, agent } of targets.projectAgents) {
    const result = await installMcpConfigToAgentProject(agent, project, devecoPath, force);
    results.push(result);
  }
  for (const agentName of targets.agents) {
    const result = await installMcpConfigToAgentProject(agentName, resolvedProject, devecoPath, force);
    results.push(result);
  }
  return results;
}

/**
 * 全局 MCP 安装：只 opencode/cursor 支持，其余收集错误信息
 */
async function installGlobalMcp(
  agentNames: string[],
  devecoPath: string | undefined,
  force: boolean
): Promise<{ results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]; errors: string[] }> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] = [];
  const errors: string[] = [];
  for (const agentName of agentNames) {
    const agentConfig = AGENT_MCP_CONFIG[agentName];
    if (!agentConfig) { continue; }
    if (!agentConfig.supportsGlobal) {
      errors.push(
        `${agentConfig.displayName} does not support global MCP configuration. ` +
        `Use --project to configure project-level MCP: devecocli init --mcp --project <path> --agent ${agentName}`
      );
      continue;
    }
    const result = await installMcpConfigToAgentGlobal(agentName, process.cwd(), devecoPath, force);
    results.push(result);
  }
  return { results, errors };
}

/**
 * 执行 MCP 配置安装（仅 --mcp 时触发）
 *
 * 场景逻辑：
 * 1. devecocli init --mcp             → 全局 MCP（只 opencode/cursor），其余报错提示用 --project
 * 2. devecocli init --mcp --project   → 只安装项目级 MCP（所有 agent 都支持项目级）
 * 3. devecocli init --mcp --force     → 全局 MCP（opencode/cursor）+ 覆盖已有配置；其余报错
 * --force 只改变覆盖行为，不改变全局/项目级模式。
 */
async function executeMcpInstallations(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string | undefined,
  options: InitOptions
): Promise<void> {
  const devecoPath = await resolveDevecoPath();
  const force = options.force ?? false;
  let mcpResults: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] = [];
  let globalErrors: string[] = [];

  if (resolvedProject) {
    mcpResults = await installProjectLevelMcp(targets, resolvedProject, devecoPath, force);
  } else {
    const { results, errors } = await installGlobalMcp(targets.agents, devecoPath, force);
    mcpResults = results;
    globalErrors = errors;
  }

  if (mcpResults.length > 0) {
    console.log(cyan('MCP Configuration:'));
    summarizeMcpResults(mcpResults);
  }

  for (const errMsg of globalErrors) {
    console.error(red(errMsg));
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
    throw new Error('Cannot use --skill and --mcp together. Use --skill for skill installation only, or --mcp for MCP configuration only.');
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
    await executeMcpInstallations(targets, resolvedProject, options);
    return;
  }

  // 默认或 --skill：只安装 skill
  const sourceFile = resolveBundledSkillMdPath();
  const skillResults = await executeSkillInstallations(targets, sourceFile, options);

  console.log();
  if (skillResults.length > 0) {
    console.log(cyan('Skill Installation:'));
    summarizeOperationResults(skillResults);
  }
}

const initCommand = new Command('init')
  .description('Install the deveco-cli skill or configure the codegenie MCP server into AI agents')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated (e.g. opencode,trae-cn,cursor,qoder,codebuddy); installs to all available agents if omitted'
  )
  .option(
    '--project <path>',
    'Project root directory to install the skill or MCP config into'
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
    'Configure the codegenie MCP server (syntax checking for .ets and C/C++) only; no skill installation'
  )
  .option('-f, --force', 'Overwrite an existing skill / MCP configuration')
  .action(async (options: InitOptions) => {
    try {
      await handleInitCommand(options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default initCommand;