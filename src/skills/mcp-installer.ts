/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import {
  AGENT_MCP_CONFIG,
  AgentMcpConfig,
  MCP_SERVER_NAME,
  buildMcpConfigForAgent,
} from '../config/mcp';
import { SkillOperationResult } from '../types/skills';

const fsp = fs.promises;

/**
 * MCP 配置安装结果
 */
export interface McpConfigResult extends SkillOperationResult {
  configPath?: string;
  agentName?: string;
  installType?: 'global' | 'project';
}

async function readJsonConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在，返回空对象，后续写入时会创建新文件
      return {};
    }
    throw new Error(`Failed to read config file ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * 写入 JSON 配置文件。
 * 注意：此函数会保留已有配置中的所有字段，只修改 mcpServers 部分。
 * 如果文件不存在，会自动创建目录和文件。
 */
async function writeJsonConfig(filePath: string, config: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const content = JSON.stringify(config, null, 2);
  await fsp.writeFile(filePath, content, 'utf8');
}

function isMcpServerConfigured(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string
): boolean {
  const mcpServers = config[mcpServersKey] as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return false;
  }
  return serverName in mcpServers;
}

function addMcpServerConfig(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
  force: boolean
): boolean {
  if (!config[mcpServersKey] || typeof config[mcpServersKey] !== 'object') {
    config[mcpServersKey] = {};
  }
  const mcpServers = config[mcpServersKey] as Record<string, unknown>;
  if (serverName in mcpServers && !force) {
    return false;
  }
  mcpServers[serverName] = serverConfig;
  return true;
}

function removeMcpServerConfig(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string
): boolean {
  const mcpServers = config[mcpServersKey] as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return false;
  }
  if (!(serverName in mcpServers)) {
    return false;
  }
  // 使用 spread 语法移除属性，避免 delete 操作符
  const { [serverName]: _, ...rest } = mcpServers;
  config[mcpServersKey] = rest;
  return true;
}

/**
 * 安装 MCP 配置到指定 agent（全局）
 */
export async function installMcpConfigToAgentGlobal(
  agentName: string,
  projectPath: string,
  devecoPath?: string,
  force: boolean = false
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return {
      success: false,
      error: `Unknown agent: ${agentName}. Supported agents: ${Object.keys(AGENT_MCP_CONFIG).join(', ')}`,
    };
  }

  if (!agentConfig.supportsGlobal) {
    // 不支持全局 MCP 配置的 agent，不应被调用到这里
    // init.ts 中已经做了报错提示，这里作为安全兜底
    return {
      success: false,
      error: `${agentConfig.displayName} does not support global MCP configuration. Use --project to configure project-level MCP.`,
    };
  }

  try {
    const config = await readJsonConfig(agentConfig.globalConfigPath);

    if (isMcpServerConfigured(config, agentConfig.mcpServersKey, MCP_SERVER_NAME) && !force) {
      console.log(`MCP server ${MCP_SERVER_NAME} already configured in ${agentConfig.globalConfigPath}`);
      return {
        success: true,
        skipped: true,
        configPath: agentConfig.globalConfigPath,
        agentName,
        installType: 'global',
      };
    }

    // 全局模式：不传 projectPath，让 buildMcpConfigForAgent 使用默认值（'.' 或 '${workspaceFolder}'）
    const serverConfig = buildMcpConfigForAgent(agentConfig, undefined, devecoPath);
    addMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME, serverConfig as unknown as Record<string, unknown>, force);

    await writeJsonConfig(agentConfig.globalConfigPath, config);
    console.log(`MCP server ${MCP_SERVER_NAME} configured in ${agentConfig.globalConfigPath}`);

    return {
      success: true,
      configPath: agentConfig.globalConfigPath,
      agentName,
      installType: 'global',
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to configure MCP for ${agentConfig.displayName}: ${(err as Error).message}`,
    };
  }
}

/**
 * 安装 MCP 配置到指定 agent（项目级）
 */
export async function installMcpConfigToAgentProject(
  agentName: string,
  projectPath: string,
  devecoPath?: string,
  force: boolean = false
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return {
      success: false,
      error: `Unknown agent: ${agentName}. Supported agents: ${Object.keys(AGENT_MCP_CONFIG).join(', ')}`,
    };
  }

  const configFile = path.join(projectPath, agentConfig.projectConfigPath);

  try {
    const config = await readJsonConfig(configFile);

    if (isMcpServerConfigured(config, agentConfig.mcpServersKey, MCP_SERVER_NAME) && !force) {
      console.log(`MCP server ${MCP_SERVER_NAME} already configured in ${configFile}`);
      return {
        success: true,
        skipped: true,
        configPath: configFile,
        agentName,
        installType: 'project',
      };
    }

    // 项目级模式：直接传入项目绝对路径作为 PROJECT_PATH，不用 '.' 或 '${workspaceFolder}'
    const serverConfig = buildMcpConfigForAgent(agentConfig, projectPath, devecoPath);
    addMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME, serverConfig as unknown as Record<string, unknown>, force);

    await writeJsonConfig(configFile, config);
    console.log(`MCP server ${MCP_SERVER_NAME} configured in ${configFile}`);

    return {
      success: true,
      configPath: configFile,
      agentName,
      installType: 'project',
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to configure MCP for ${agentConfig.displayName}: ${(err as Error).message}`,
    };
  }
}

/**
 * 移除 MCP 配置（全局）
 */
export async function removeMcpConfigFromAgentGlobal(agentName: string): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return { success: false, error: `Unknown agent: ${agentName}` };
  }

  if (!agentConfig.globalConfigPath) {
    return { success: true, skipped: true, agentName };
  }

  try {
    const config = await readJsonConfig(agentConfig.globalConfigPath);

    if (!removeMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME)) {
      console.log(`MCP server ${MCP_SERVER_NAME} not found in ${agentConfig.globalConfigPath}`);
      return {
        success: true,
        skipped: true,
        configPath: agentConfig.globalConfigPath,
        agentName,
        installType: 'global',
      };
    }

    await writeJsonConfig(agentConfig.globalConfigPath, config);
    console.log(`MCP server ${MCP_SERVER_NAME} removed from ${agentConfig.globalConfigPath}`);

    return {
      success: true,
      configPath: agentConfig.globalConfigPath,
      agentName,
      installType: 'global',
    };
  } catch (err) {
    return { success: false, error: `Failed to remove MCP config: ${(err as Error).message}` };
  }
}

/**
 * 移除 MCP 配置（项目级）
 */
export async function removeMcpConfigFromAgentProject(
  agentName: string,
  projectPath: string
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return { success: false, error: `Unknown agent: ${agentName}` };
  }

  const configFile = path.join(projectPath, agentConfig.projectConfigPath);

  try {
    const config = await readJsonConfig(configFile);

    if (!removeMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME)) {
      console.log(`MCP server ${MCP_SERVER_NAME} not found in ${configFile}`);
      return {
        success: true,
        skipped: true,
        configPath: configFile,
        agentName,
        installType: 'project',
      };
    }

    await writeJsonConfig(configFile, config);
    console.log(`MCP server ${MCP_SERVER_NAME} removed from ${configFile}`);

    return {
      success: true,
      configPath: configFile,
      agentName,
      installType: 'project',
    };
  } catch (err) {
    return { success: false, error: `Failed to remove MCP config: ${(err as Error).message}` };
  }
}

export function getSupportedMcpAgents(): string[] {
  return Object.keys(AGENT_MCP_CONFIG);
}

export function getAgentMcpConfig(agentName: string): AgentMcpConfig | undefined {
  return AGENT_MCP_CONFIG[agentName];
}

export function summarizeMcpResults(results: McpConfigResult[]): void {
  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;

  console.log();
  console.log('MCP Configuration Results:');
  console.log(`  Success: ${successCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Failed: ${failedCount}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}