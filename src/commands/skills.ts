/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { green, red, cyan, yellow, dim } from 'colorette';
import pLimit from 'p-limit';
import { SpinnerHelper } from '../utils/spinner-helper.js';
import {
  fetchTagIds,
  fetchAllSkills,
  searchSkills,
  getInstalledAgents,
} from '../skills/api';
import {
  downloadSkill,
  installSkillToPath,
  installSkillToAgentWithBuffer,
  installSkillToProjectAgent,
  removeSkillFromAgent,
  removeSkillFromPath,
  removeSkillFromProjectAgent,
} from '../skills/installer';
import {
  parseAgentList,
  getAllExistingAgents,
  summarizeOperationResults,
  validatePathMutex,
  validateDirectoryPath,
  resolveInstallationTargets,
} from '../skills/agents';
import {
  AddOptions,
  RemoveOptions,
  SkillOperationResult,
  InstallationTargets,
} from '../types/skills';

/**
 * 获取要安装的技能名称列表
 */
async function getSkillNames(options: AddOptions): Promise<string[]> {
  const tagIds = await fetchTagIds();

  if (options.all) {
    // 如果 --all，调用 API 获取所有技能
    const skills = await fetchAllSkills(tagIds);
    return skills.map((s) => s.enName);
  } else {
    // 如果 --skill，查找指定技能（精确匹配 enName）
    const allSkills = await searchSkills(options.skill!, tagIds);
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
  targets: InstallationTargets,
  force: boolean
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];

  // 安装到自定义路径（如果有）
  if (targets.customPath) {
    const result = await installSkillToPath(
      skillName,
      zipBuffer,
      targets.customPath,
      force
    );
    results.push(result);
    return results;
  }

  // 批量安装到多个 agent（如果有）
  for (const agentName of targets.agents) {
    const result = await installSkillToAgentWithBuffer(
      skillName,
      agentName,
      zipBuffer,
      force
    );
    results.push(result);
  }

  // 批量安装到 projectAgents（如果有）
  for (const { project, agent } of targets.projectAgents) {
    const result = await installSkillToProjectAgent(
      skillName,
      zipBuffer,
      project,
      agent,
      force
    );
    results.push(result);
  }

  return results;
}

/**
 * 验证 add 命令的参数
 * @returns 解析后的路径
 */
function validateAddOptions(options: AddOptions): {
  resolvedPath: string | undefined;
  resolvedProject: string | undefined;
} {
  // 1. 参数验证：--all 和 --skill 不能同时指定
  if (options.all && options.skill) {
    throw new Error('--all and --skill cannot be specified together');
  }

  // 2. 参数验证：必须提供 --all 或 --skill
  if (!options.all && !options.skill) {
    throw new Error('Must specify --all or --skill');
  }

  // 3. 互斥验证并解析路径
  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );

  // 4. 目录存在性检查
  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory', options.force);
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory', options.force);
  }

  return { resolvedPath, resolvedProject };
}

/**
 * 获取安装目标（skill 名称列表和安装目标）
 */
async function getInstallationTargets(
  options: AddOptions,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<{
  skillNames: string[];
  targets: InstallationTargets;
}> {
  const targets = await resolveInstallationTargets(
    options,
    resolvedPath,
    resolvedProject
  );
  const skillNames = await getSkillNames(options);
  return { skillNames, targets };
}

/**
 * 批量安装技能
 */
async function installSkills(
  skillNames: string[],
  targets: InstallationTargets,
  force: boolean,
  spinner: SpinnerHelper
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];
  const total = skillNames.length;
  const limit = pLimit(5);

  // 并发启动下载任务
  const downloadPromises = skillNames.map(async (name) => {
    return limit(async () => {
      try {
        const buffer = await downloadSkill(name);
        return { name, buffer, success: true as const };
      } catch (error: unknown) {
        const errorMsg =
          error instanceof Error ? error.message : 'unknown error';
        return { name, error: errorMsg, success: false as const };
      }
    });
  });

  for (let i = 0; i < skillNames.length; i++) {
    const skillName = skillNames[i];
    const progress = total > 1 ? ` (${i + 1}/${total})` : '';
    spinner.start(`Installing ${skillName}${progress}...`);

    // 等待当前技能的下载结果
    const downloadResult = await downloadPromises[i];
    if (!downloadResult.success) {
      spinner.fail();
      console.log(
        red(`${skillName}: Download failed - ${downloadResult.error}`)
      );
      results.push({ success: false });
      continue;
    }
    spinner.stop();
    const installResults = await installSingleSkill(
      skillName,
      downloadResult.buffer,
      targets,
      force
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
    const { resolvedPath, resolvedProject } = validateAddOptions(options);

    const { skillNames, targets } = await getInstallationTargets(
      options,
      resolvedPath,
      resolvedProject
    );

    const results = await installSkills(
      skillNames,
      targets,
      options.force || false,
      spinner
    );

    spinner.stop();
    summarizeOperationResults(results);
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

/**
 * 验证 remove 命令的参数
 * @returns 解析后的路径
 */
function validateRemoveOptions(options: RemoveOptions): {
  resolvedPath: string | undefined;
  resolvedProject: string | undefined;
} {
  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );
  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory');
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory');
  }
  return { resolvedPath, resolvedProject };
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
    const { resolvedPath, resolvedProject } = validateRemoveOptions(options);
    spinner.stop();
    const results = await removeSkill(
      options,
      skillName,
      resolvedPath,
      resolvedProject
    );
    spinner.stop();
    summarizeOperationResults(results);
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

/**
 * 验证 agents 列表不为空
 */
function validateAgentsNotEmpty(agents: string[], hint: string = ''): void {
  if (agents.length === 0) {
    throw new Error(
      `No agents found. Please install an AI agent (cursor, opencode, etc.) ${hint}`
    );
  }
}

/**
 * 批量移除技能从多个目标
 */
async function removeSkillFromTargets(
  skillName: string,
  targets: Array<{
    type: 'agent' | 'projectAgent';
    agent: string;
    project?: string;
  }>
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];
  for (const target of targets) {
    const result =
      target.type === 'agent'
        ? await removeSkillFromAgent(skillName, target.agent)
        : await removeSkillFromProjectAgent(
            skillName,
            target.project!,
            target.agent
          );
    results.push(result);
  }
  return results;
}

async function removeSkill(
  options: RemoveOptions,
  skillName: string,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<SkillOperationResult[]> {
  // Case 1: --path alone
  if (resolvedPath) {
    const result = await removeSkillFromPath(skillName, resolvedPath);
    return [result];
  }
  // Case 2: --project + --agent
  if (resolvedProject && options.agent) {
    const agents = await parseAgentList(options.agent);
    const targets = agents.map((a) => ({
      type: 'projectAgent' as const,
      agent: a,
      project: resolvedProject,
    }));
    return removeSkillFromTargets(skillName, targets);
  }
  // Case 3: --project alone
  if (resolvedProject) {
    const agents = await getAllExistingAgents();
    validateAgentsNotEmpty(agents);
    const targets = agents.map((a) => ({
      type: 'projectAgent' as const,
      agent: a,
      project: resolvedProject,
    }));
    return removeSkillFromTargets(skillName, targets);
  }
  // Case 4: --agent alone
  if (options.agent) {
    const agents = await parseAgentList(options.agent);
    const targets = agents.map((a) => ({ type: 'agent' as const, agent: a }));
    return removeSkillFromTargets(skillName, targets);
  }
  // Case 5: No flags
  const agents = await getAllExistingAgents();
  validateAgentsNotEmpty(agents, 'or use --path for a custom location.');
  const targets = agents.map((a) => ({ type: 'agent' as const, agent: a }));
  return removeSkillFromTargets(skillName, targets);
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
      const tagIds = await fetchTagIds();

      // 获取所有技能
      const skills = await fetchAllSkills(tagIds);

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
      const tagIds = await fetchTagIds();

      // 搜索技能
      const skills = await searchSkills(keyword, tagIds);

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
    'Target agents, comma-separated (e.g. opencode,trae-cn,cursor,qoder,codebuddy); installs to all available agents if omitted'
  )
  .option('--skill <skill-name>', 'Name of the skill to install')
  .option('-f, --force', 'Overwrite an existing skill installation')
  .option(
    '--project <path>',
    'Project root directory to install the skill into'
  )
  .option(
    '--path <path>',
    'Path to install the skill directly (cannot be used with --project or --agent)'
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
    'Target agents, comma-separated (e.g. opencode,trae-cn,cursor,qoder,codebuddy); removes from all available agents if omitted'
  )
  .option('--project <path>', 'Project root directory to remove the skill from')
  .option('--path <path>', 'Path to remove the skill from')
  .action(async (options: RemoveOptions) => {
    try {
      await handleRemoveCommand(options.skill!, options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default skillsCommand;
