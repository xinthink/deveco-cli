/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { red } from 'colorette';
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
import { InitOptions, SkillOperationResult } from '../types/skills';

const DEVECO_CLI_SKILL_NAME = 'deveco-cli';

/**
 * 把 deveco-cli 自带的 SKILL.md 复制到各 AI agent / 项目的 skills 目录
 */
async function handleInitCommand(options: InitOptions): Promise<void> {
  // 1. 互斥验证并解析路径
  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );

  // 2. 目录存在性检查
  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory');
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory');
  }

  const sourceFile = resolveBundledSkillMdPath();

  // 3. 解析安装目标
  const targets = await resolveInstallationTargets(
    options,
    resolvedPath,
    resolvedProject
  );

  const results: SkillOperationResult[] = [];

  // 4. 安装到自定义路径（如果有）
  if (targets.customPath) {
    const result = await installLocalSkillToPath(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      targets.customPath,
      options.force
    );
    results.push(result);
    summarizeOperationResults(results);
    return;
  }

  // 5. 安装到项目级 agents（如果有）
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

  // 6. 安装到全局 agents（如果有）
  for (const agentName of targets.agents) {
    const result = await installLocalSkillToAgent(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      agentName,
      options.force
    );
    results.push(result);
  }

  summarizeOperationResults(results);
}

const initCommand = new Command('init')
  .description('Install the deveco-cli skill into AI agents')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated (e.g. opencode,trae-cn,cursor,qoder,codebuddy); installs to all available agents if omitted'
  )
  .option(
    '--project <path>',
    'Project root directory to install the skill into'
  )
  .option(
    '--path <path>',
    'Path to install the skill directly (cannot be used with --project or --agent)'
  )
  .option('-f, --force', 'Overwrite an existing skill installation')
  .action(async (options: InitOptions) => {
    try {
      await handleInitCommand(options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default initCommand;
