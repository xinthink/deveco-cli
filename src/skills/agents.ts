/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { green, red, yellow, cyan } from 'colorette';
import { AGENT_SKILLS_CONFIG } from '../config/constants';
import { SkillOperationResult } from '../types/skills';
import { checkAgentExists } from './installer';

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
  console.log(`  ${green('Success')}: ${successCount}`);
  console.log(`  ${yellow('Skipped')}: ${skippedCount}`);
  console.log(`  ${red('Failed')}: ${failedCount}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}
