/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import { cyan } from 'colorette';
import { AGENT_SKILLS_CONFIG } from '../config/constants';
import { SkillOperationResult, InstallationTargets } from '../types/skills';
import { checkAgentExists, resolvePath } from './installer';

/**
 * 解析和验证 agent 列表
 * @param agentOption 逗号分隔的 agent 列表字符串
 * @returns 验证通过的 agent 名称列表
 * @throws 如果任何 agent 不存在
 */
export async function parseAgentList(
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
export async function getAllExistingAgents(): Promise<string[]> {
  const agents: string[] = [];

  for (const agentName of Object.keys(AGENT_SKILLS_CONFIG)) {
    if (await checkAgentExists(agentName)) {
      agents.push(agentName);
    }
  }

  return agents;
}

/**
 * 汇总并输出 skill 操作结果
 * 失败计数 > 0 时设置 process.exitCode = 1
 */
export function summarizeOperationResults(
  results: SkillOperationResult[]
): void {
  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;

  console.log();
  console.log(cyan('Finished:'));
  console.log(`  Success: ${successCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Failed: ${failedCount}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

/**
 * 验证路径存在且是目录
 */
export function validateDirectoryPath(path: string, label: string, force?: boolean): void {
  if (!fs.existsSync(path)) {
    if (force) {
      return;
    }
    throw new Error(`${label} "${path}" not found`);
  }
  if (!fs.statSync(path).isDirectory()) {
    throw new Error(`"${path}" is not a directory`);
  }
}

/**
 * 验证 --path 与 --project/--agent 互斥，并解析路径
 * @returns 解析后的路径（如果有）
 */
export function validatePathMutex(
  pathOpt: string | undefined,
  project: string | undefined,
  agent: string | undefined
): { resolvedPath: string | undefined; resolvedProject: string | undefined } {
  if (pathOpt && (project || agent)) {
    throw new Error('Cannot use `--path` with `--project` or `--agent`');
  }
  return {
    resolvedPath: pathOpt ? resolvePath(pathOpt) : undefined,
    resolvedProject: project ? resolvePath(project) : undefined,
  };
}

/**
 * 解析安装目标（agents、projectAgents、customPath）
 * @param options 包含 agent、project、path 的选项对象
 * @param resolvedPath 已解析的自定义路径
 * @param resolvedProject 已解析的项目路径
 * @returns 安装目标对象
 */
export async function resolveInstallationTargets(
  options: { agent?: string; project?: string; path?: string },
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<InstallationTargets> {
  let agents: string[] = [];
  let projectAgents: Array<{ project: string; agent: string }> = [];
  let customPath: string | undefined;

  if (resolvedPath) {
    customPath = resolvedPath;
  } else if (resolvedProject && options.agent) {
    const parsedAgents = await parseAgentList(options.agent);
    projectAgents = parsedAgents.map((agentName) => ({
      project: resolvedProject,
      agent: agentName,
    }));
  } else if (resolvedProject) {
    const allAgents = await getAllExistingAgents();
    projectAgents = allAgents.map((agentName) => ({
      project: resolvedProject,
      agent: agentName,
    }));
  } else if (options.agent) {
    agents = await parseAgentList(options.agent);
  } else {
    agents = await getAllExistingAgents();
  }

  // 检查是否有有效的安装目标
  if (!customPath && agents.length === 0 && projectAgents.length === 0) {
    throw new Error(
      'No agents found. Install an AI agent (cursor, opencode, etc.) ' +
      'or use `--path` for a custom location.'
    );
  }

  return { agents, projectAgents, customPath };
}
