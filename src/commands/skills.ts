/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import fs from 'fs';
import { green, red, cyan, yellow, dim } from 'colorette';
import {
  fetchHmosTagId,
  fetchAllSkills,
  searchSkills,
  getInstalledAgents,
} from '../skills/api';
import {
  checkAgentExists,
  downloadSkill,
  installSkillToAgentWithBuffer,
  installSkillToProject,
  clearDownloadCache,
  removeSkillFromAgent,
  removeSkillFromProject,
} from '../skills/installer';
import { AGENT_SKILLS_CONFIG } from '../config/constants';
import {
  AddOptions,
  RemoveOptions,
  SkillOperationResult,
} from '../types/skills';

/**
 * 解析和验证 agent 列表
 * @param agentOption 逗号分隔的 agent 列表字符串
 * @returns 验证通过的 agent 名称列表
 * @throws 如果任何 agent 不存在
 */
async function parseAgentList(
  agentOption: string | undefined
): Promise<string[]> {
  if (!agentOption) {
    return [];
  }

  const agents: string[] = [];
  const agentList = agentOption.split(',').map((a) => a.trim());

  for (const agentName of agentList) {
    if (!(await checkAgentExists(agentName))) {
      throw new Error(`Agent ${agentName} not found`);
    }
    agents.push(agentName);
  }

  return agents;
}

/**
 * 获取所有实际存在的 agents
 * @returns 存在的 agent 名称列表
 */
async function getAllExistingAgents(): Promise<string[]> {
  const agents: string[] = [];

  for (const agentName of Object.keys(AGENT_SKILLS_CONFIG)) {
    if (await checkAgentExists(agentName)) {
      agents.push(agentName);
    }
  }

  return agents;
}

/**
 * 汇总并输出结果
 * @param results 结果列表
 */
function summarizeOperationResults(results: SkillOperationResult[]): void {
  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;
  console.log();
  console.log(cyan('Operation completed:'));
  console.log(`  ${green('Success')}: ${successCount}`);
  console.log(`  ${yellow('Skipped')}: ${skippedCount}`);
  console.log(`  ${red('Failed')}: ${failedCount}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

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
 * 处理 add 子命令
 */
async function handleAddCommand(options: AddOptions): Promise<void> {
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

  // 4. 获取技能名称列表
  const skillNames = await getSkillNames(options);

  // 5. 获取 agent 列表
  let agents: string[] = [];
  if (options.agent) {
    agents = await parseAgentList(options.agent);
  } else if (!options.project) {
    agents = await getAllExistingAgents();
  }

  // 6. 循环安装
  const results: SkillOperationResult[] = [];

  for (const skillName of skillNames) {
    // 先下载 skill（带缓存，避免重复下载）
    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadSkill(skillName);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'unknown error';
      console.log(red(`${skillName}: Download failed - ${errorMsg}`));
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

  // 7. 汇总输出
  summarizeOperationResults(results);
}

/**
 * 处理 remove 子命令
 */
async function handleRemoveCommand(
  skillName: string,
  options: RemoveOptions
): Promise<void> {
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

  // 3. 循环移除
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

  // 4. 汇总输出
  summarizeOperationResults(results);
}

// 创建主命令
const skillsCommand = new Command('skills').description('Manage HMOS skills.');

// 添加 list 子命令
skillsCommand
  .command('list')
  .description('List all available HMOS skills.')
  .option(
    '-l, --long',
    'Show detailed information with description and installation status'
  )
  .action(async (options: { long?: boolean }) => {
    try {
      const tagId = await fetchHmosTagId();

      // 获取所有技能
      const skills = await fetchAllSkills(tagId);

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
      console.log(red('Skills list failed'));
      if (error instanceof Error && error.message) {
        console.error(red(error.message));
      }
      process.exit(1);
    }
  });

// 添加 find 子命令
skillsCommand
  .command('find <keyword>')
  .description('Search skills by keyword.')
  .action(async (keyword: string) => {
    try {
      const tagId = await fetchHmosTagId();

      // 搜索技能
      const skills = await searchSkills(keyword, tagId);

      // 处理空结果
      if (skills.length === 0) {
        console.log(yellow(`No skills found matching '${keyword}'`));
        return;
      }

      // 输出搜索结果
      for (const skill of skills) {
        console.log(cyan(skill.enName));
        console.log(dim(skill.description));
        console.log();
      }
    } catch (error: unknown) {
      console.log(red('Skills find failed'));
      if (error instanceof Error && error.message) {
        console.error(red(error.message));
      }
      process.exit(1);
    }
  });

// 添加 add 子命令
skillsCommand
  .command('add')
  .description('Install skills to AI agents.')
  .option('--all', 'Install all available skills')
  .option(
    '--agent <agents>',
    "Target agents (comma-separated, e.g., 'codebuddy,opencode'). If omitted, installs to all available agents."
  )
  .option('--skill <skill-name>', 'Specific skill to install.')
  .option(
    '-f, --force',
    'Force reinstall: overwrite existing skill installation if already present.'
  )
  .option('--project <path>', 'Path to a project root in which to install.')
  .action(async (options: AddOptions) => {
    try {
      await handleAddCommand(options);
    } catch (error: unknown) {
      console.log(red('Skills add failed'));
      if (error instanceof Error && error.message) {
        console.error(red(error.message));
      }
      process.exit(1);
    } finally {
      // 确保无论成功还是失败，都清理下载缓存
      clearDownloadCache();
    }
  });

// 添加 remove 子命令
skillsCommand
  .command('remove <skill-name>')
  .description(
    'Remove an installed skill from AI agents. Deletes the skill directory from specified agents. By default removes from all available agents.'
  )
  .option(
    '--agent <agents>',
    "Target agents (comma-separated, e.g., 'codebuddy,opencode'). If omitted, removes from all available agents."
  )
  .option('--project <path>', 'Path to a project root from which to remove.')
  .action(async (skillName: string, options: RemoveOptions) => {
    try {
      await handleRemoveCommand(skillName, options);
    } catch (error: unknown) {
      console.log(red('Skills remove failed'));
      if (error instanceof Error && error.message) {
        console.error(red(error.message));
      }
      process.exit(1);
    }
  });

export default skillsCommand;
