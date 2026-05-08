/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import fs from 'fs';
import { red, cyan } from 'colorette';
import {
  installLocalSkillToAgent,
  installLocalSkillToProject,
  resolveBundledSkillMdPath,
} from '../skills/installer';
import {
  parseAgentList,
  getAllExistingAgents,
  summarizeOperationResults,
} from '../skills/agents';
import { InitOptions, SkillOperationResult } from '../types/skills';

const DEVECO_CLI_SKILL_NAME = 'deveco-cli';

/**
 * 把 deveco-cli 自带的 SKILL.md 复制到各 AI agent / 项目的 skills 目录
 */
async function handleInitCommand(options: InitOptions): Promise<void> {
  if (options.project && !fs.existsSync(options.project)) {
    throw new Error(`目录 "${options.project}" 不存在`);
  }

  const sourceFile = resolveBundledSkillMdPath();

  let agents: string[] = [];
  if (options.agent) {
    agents = await parseAgentList(options.agent);
  } else if (!options.project) {
    agents = await getAllExistingAgents();
  }

  const results: SkillOperationResult[] = [];

  if (options.project) {
    const result = await installLocalSkillToProject(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      options.project,
      options.force
    );
    results.push(result);
  }

  for (const agentName of agents) {
    const result = await installLocalSkillToAgent(
      DEVECO_CLI_SKILL_NAME,
      sourceFile,
      agentName,
      options.force
    );
    results.push(result);
  }

  console.log();
  console.log(cyan('安装完成:'));
  summarizeOperationResults(results);
}

const initCommand = new Command('init')
  .description(
    'Install the bundled deveco-cli skill to AI agents (and/or a project), so agents can learn how to invoke deveco.'
  )
  .option(
    '--agent <agents>',
    "Target agents (comma-separated, e.g., 'claude,opencode,gemini'). If omitted, installs to all available agents."
  )
  .option('--project <path>', 'Path to a project root in which to install.')
  .option(
    '-f, --force',
    'Force reinstall: overwrite the existing skill installation if already present.'
  )
  .action(async (options: InitOptions) => {
    try {
      await handleInitCommand(options);
    } catch (error: unknown) {
      console.log(red('Init failed'));
      if (error instanceof Error && error.message) {
        console.error(red(error.message));
      }
      process.exit(1);
    }
  });

export default initCommand;
