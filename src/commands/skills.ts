/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import fs from 'fs';
import { green, red, cyan, yellow, dim } from 'colorette';
import { SpinnerHelper } from '../utils/spinner-helper.js';
import {
  fetchHmosTagId,
  fetchAllSkills,
  searchSkills,
  getInstalledAgents,
} from '../skills/api';
import {
  downloadSkill,
  installSkillToAgentWithBuffer,
  installSkillToProject,
  removeSkillFromAgent,
  removeSkillFromProject,
} from '../skills/installer';
import {
  parseAgentList,
  getAllExistingAgents,
  summarizeOperationResults,
} from '../skills/agents';
import {
  AddOptions,
  RemoveOptions,
  SkillOperationResult,
} from '../types/skills';

/**
 * 获取要安装的技能名称列表
 */
async function getSkillNames(options: AddOptions): Promise<string[]> {
  const tagId = await fetchHmosTagId();

  if (options.all) {
    // 如果 --all，调用 API 获取所有技能
    const skills = await fetchAllSkills(tagId);
    return skills.map((s) => s.enName);
  } else {
    // 如果 --skill，查找指定技能（精确匹配 enName）
    const allSkills = await searchSkills(options.skill!, tagId);
    const skill = allSkills.find((s) => s.enName === options.skill);
    if (!skill) {
      throw new Error(`Skill "${options.skill}" not found`);
    }
    return [skill.enName];
  }
}

/**
 * 安装单个技能到项目和 agents
 */
async function installSingleSkill(
  skillName: string,
  zipBuffer: Buffer,
  agents: string[],
  options: AddOptions
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];

  // 批量安装到项目（如果指定）
  if (options.project) {
    const result = await installSkillToProject(
      skillName,
      zipBuffer,
      options.project,
      options.force
    );
    results.push(result);
  }

  // 批量安装到多个 agent（如果有）
  for (const agentName of agents) {
    const result = await installSkillToAgentWithBuffer(
      skillName,
      agentName,
      zipBuffer,
      options.force
    );
    results.push(result);
  }

  return results;
}

/**
 * 验证 add 命令的参数
 */
function validateAddOptions(options: AddOptions): void {
  // 1. 参数验证：--all 和 --skill 不能同时指定
  if (options.all && options.skill) {
    throw new Error('--all and --skill cannot be specified together');
  }

  // 2. 参数验证：必须提供 --all 或 --skill
  if (!options.all && !options.skill) {
    throw new Error('Must specify --all or --skill');
  }

  // 3. 目录存在性检查
  if (options.project && !fs.existsSync(options.project)) {
    throw new Error(`Directory "${options.project}" not found`);
  }
}

/**
 * 获取安装目标（skill 名称列表和 agent 列表）
 */
async function getInstallationTargets(options: AddOptions): Promise<{
  skillNames: string[];
  agents: string[];
}> {
  // 1. 获取 agent 列表
  let agents: string[] = [];
  if (options.agent) {
    agents = await parseAgentList(options.agent);
  } else if (!options.project) {
    agents = await getAllExistingAgents();
  }
  // 2. 获取技能名称列表
  const skillNames = await getSkillNames(options);
  return { skillNames, agents };
}

/**
 * 批量安装技能
 */
async function installSkills(
  skillNames: string[],
  agents: string[],
  options: AddOptions,
  spinner: SpinnerHelper
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];
  const total = skillNames.length;

  for (let i = 0; i < skillNames.length; i++) {
    const skillName = skillNames[i];
    const progress = total > 1 ? ` (${i + 1}/${total})` : '';
    // 下载skill压缩包
    spinner.start(`Installing ${skillName}${progress}...`);
    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadSkill(skillName);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'unknown error';
      spinner.fail();
      console.log(red(`${skillName}: Download failed - ${errorMsg}`));
      results.push({ success: false });
      continue;
    }
    // 安装技能
    const installResults = await installSingleSkill(
      skillName,
      zipBuffer,
      agents,
      options
    );
    results.push(...installResults);
  }

  return results;
}

/**
 * 处理 add 子命令
 */
async function handleAddCommand(options: AddOptions): Promise<void> {
  const spinner = new SpinnerHelper();
  try {
    spinner.start(`Installing skill...`);
    validateAddOptions(options);

    const { skillNames, agents } = await getInstallationTargets(options);

    const results = await installSkills(skillNames, agents, options, spinner);

    spinner.stop();
    summarizeOperationResults(results);
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

/**
 * 处理 remove 子命令
 */
async function handleRemoveCommand(
  skillName: string,
  options: RemoveOptions
): Promise<void> {
  const spinner = new SpinnerHelper();
  try {
    spinner.start('Removing skill...');
    // 1. 目录存在性检查
    if (options.project && !fs.existsSync(options.project)) {
      throw new Error(`Project directory "${options.project}" not found`);
    }
    // 2. 获取 agent 列表
    let agents: string[] = [];
    if (options.agent) {
      agents = await parseAgentList(options.agent);
    } else if (!options.project) {
      agents = await getAllExistingAgents();
    }
    // 3. 移除
    const results: SkillOperationResult[] = await removeSkill(options, skillName, agents);
    // 4. 汇总输出
    spinner.stop();
    summarizeOperationResults(results);
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

async function removeSkill(options: RemoveOptions, skillName: string, agents: string[]) {
  const results: SkillOperationResult[] = [];

  if (options.project) {
    const result = await removeSkillFromProject(skillName, options.project);
    results.push(result);
  }

  if (agents.length > 0) {
    for (const agentName of agents) {
      const result = await removeSkillFromAgent(skillName, agentName);
      results.push(result);
    }
  }
  return results;
}

// 创建主命令
const skillsCommand = new Command('skills').description('Manage HMOS skills');

// 添加 list 子命令
skillsCommand
  .command('list')
  .description('List all available HMOS skills')
  .option(
    '-l, --long',
    'Show detailed information including description and installation status'
  )
  .action(async (options: { long?: boolean }) => {
    const spinner = new SpinnerHelper();
    try {
      spinner.start('Fetching skills...');
      const tagId = await fetchHmosTagId();

      // 获取所有技能
      const skills = await fetchAllSkills(tagId);

      // 处理空结果
      if (skills.length === 0) {
        spinner.stop();
        console.log(yellow('No skills available'));
        return;
      }
      spinner.succeed(`Fetched ${skills.length} skills`);

      // 输出技能列表
      for (const skill of skills) {
        if (options.long) {
          console.log(cyan(skill.enName));
          console.log(dim(skill.description));

          // 获取已安装的 agent 列表
          const installedAgents = getInstalledAgents(skill.enName);
          if (installedAgents.length > 0) {
            console.log(green(`Installed for: ${installedAgents.join(', ')}`));
          }
          console.log();
        } else {
          console.log(skill.enName);
        }
      }
    } catch (error: unknown) {
      spinner.stop();
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

// 添加 find 子命令
skillsCommand
  .command('find <keyword>')
  .description('Search skills by keyword')
  .action(async (keyword: string) => {
    const spinner = new SpinnerHelper();
    try {
      spinner.start('Searching skills...');
      const tagId = await fetchHmosTagId();

      // 搜索技能
      const skills = await searchSkills(keyword, tagId);

      // 处理空结果
      if (skills.length === 0) {
        console.log(yellow(`No skills found matching '${keyword}'`));
        spinner.stop();
        return;
      }

      spinner.succeed(`Found ${skills.length} skills`);

      // 输出搜索结果
      for (const skill of skills) {
        console.log(cyan(skill.enName));
        console.log(dim(skill.description));
        console.log();
      }
    } catch (error: unknown) {
      spinner.stop();
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

// 添加 add 子命令
skillsCommand
  .command('add')
  .description('Install skills to AI agents')
  .option('--all', 'Install all available skills')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated (e.g. codebuddy,opencode); installs to all available agents if omitted'
  )
  .option('--skill <skill-name>', 'Name of the skill to install')
  .option('-f, --force', 'Overwrite an existing skill installation')
  .option(
    '--project <path>',
    'Project root directory to install the skill into'
  )
  .action(async (options: AddOptions) => {
    try {
      await handleAddCommand(options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

// 添加 remove 子命令
skillsCommand
  .command('remove')
  .description('Remove an installed skill from AI agents')
  .requiredOption('--skill <skill-name>', 'Name of the skill to remove')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated (e.g. codebuddy,opencode); removes from all available agents if omitted'
  )
  .option('--project <path>', 'Project root directory to remove the skill from')
  .action(async (options: RemoveOptions) => {
    try {
      await handleRemoveCommand(options.skill!, options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default skillsCommand;