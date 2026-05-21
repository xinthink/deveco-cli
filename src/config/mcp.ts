/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'os';
import path from 'path';

/**
 * MCP Server 名称
 */
export const MCP_SERVER_NAME = 'codegenie';

/**
 * OpenCode MCP Local Server 配置格式
 * OpenCode 使用 `mcp` 字段， */
export interface OpenCodeMcpConfig {
  /** 类型：local */
  type: 'local';
  /** 命令和参数数组 */
  command: string[];
  /** 环境变量 */
  environment?: Record<string, string>;
  /** 是否启用 */
  enabled?: boolean;
  /** 超时时间 (ms) */
  timeout?: number;
}

/**
 * 标准 MCP Server 配置 (其他 AI 使用)
 * 用于 stdio 类型的 MCP 服务器
 */
export interface McpServerConfig {
  /** 服务器类型，默认 stdio */
  type?: 'stdio' | 'sse';
  /** 执行命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * Agent MCP 配置信息
 */
export interface AgentMcpConfig {
  /** Agent 名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 是否支持全局 MCP 配置 */
  supportsGlobal: boolean;
  /** 全局配置文件路径（仅 supportsGlobal=true 时有效） */
  globalConfigPath: string;
  /** 项目级配置文件路径 */
  projectConfigPath: string;
  /** 配置文件中 MCP servers 的 JSON key */
  mcpServersKey: string;
  /** 配置格式类型 */
  format: 'standard' | 'opencode';
}

/** 支持全局 MCP 配置的 agent 名称列表 */
export const GLOBAL_MCP_AGENTS = ['opencode', 'cursor'];

/**
 * 各 AI Agent 的 MCP 配置信息
 */
export const AGENT_MCP_CONFIG: Record<string, AgentMcpConfig> = {
  /**
   * OpenCode - 支持全局 + 项目级
   * 全局：~/.config/opencode/opencode.json
   * 使用 `mcp` 字段，command 是数组格式
   */
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.config', 'opencode', 'opencode.json'),
    projectConfigPath: '.opencode/opencode.json',
    mcpServersKey: 'mcp',
    format: 'opencode',
  },

  /**
   * Trae-CN - 只支持项目级
   * 需要使用 --project 参数配置项目级 MCP
   */
  'trae-cn': {
    name: 'trae-cn',
    displayName: 'Trae-CN',
    supportsGlobal: false,
    globalConfigPath: '',
    projectConfigPath: '.trae-cn/trae.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Cursor - 支持全局 + 项目级
   * 全局：~/.cursor/mcp.json (2025+ 支持)
   * 项目级：.cursor/mcp.json
   */
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.cursor', 'mcp.json'),
    projectConfigPath: '.cursor/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Codebuddy - 只支持项目级
   * 需要使用 --project 参数配置项目级 MCP
   */
  codebuddy: {
    name: 'codebuddy',
    displayName: 'Codebuddy',
    supportsGlobal: false,
    globalConfigPath: '',
    projectConfigPath: '.codebuddy/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Qoder - 只支持项目级
   * 需要使用 --project 参数配置项目级 MCP
   */
  qoder: {
    name: 'qoder',
    displayName: 'Qoder',
    supportsGlobal: false,
    globalConfigPath: '',
    projectConfigPath: '.qoder/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },
};

/**
 * 构建 OpenCode MCP Server 配置
 * - 全局模式：PROJECT_PATH = '.'（当前目录），MCP server 会从 process.cwd() 自动检测项目
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildOpenCodeMcpConfig(
  projectPath?: string,
  devecoPath?: string
): OpenCodeMcpConfig {
  const environment: Record<string, string> = {
    // 全局用 '.'（MCP server 使用 process.cwd()），项目级直接写入绝对路径
    PROJECT_PATH: projectPath ?? '.',
    NODE_MAX_OLD_SPACE_SIZE: '8192',
  };

  if (devecoPath) {
    environment.DEVECO_PATH = devecoPath;
  }

  return {
    type: 'local',
    command: ['devecocli', 'start', 'mcp'],
    environment,
    enabled: true,
  };
}

/**
 * 构建标准 MCP Server 配置
 * - 全局模式：PROJECT_PATH = '${workspaceFolder}'，AI 客户端会自动替换为当前项目路径
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildMcpServerConfig(
  projectPath?: string,
  devecoPath?: string
): McpServerConfig {
  const env: Record<string, string> = {
    // 全局用 '${workspaceFolder}'（AI 客户端替换），项目级直接写入绝对路径
    PROJECT_PATH: projectPath ?? '${workspaceFolder}',
    NODE_MAX_OLD_SPACE_SIZE: '8192',
  };

  if (devecoPath) {
    env.DEVECO_PATH = devecoPath;
  }

  return {
    type: 'stdio',
    command: 'devecocli',
    args: ['start', 'mcp'],
    env,
  };
}

/**
 * 根据 agent 的格式类型构建 MCP 配置
 * - 全局模式：OpenCode 用 '.'，其他用 '${workspaceFolder}'
 * - 项目级模式（有 projectPath）：所有 agent 的 PROJECT_PATH 直接写入项目绝对路径
 */
export function buildMcpConfigForAgent(
  agentConfig: AgentMcpConfig,
  projectPath?: string,
  devecoPath?: string
): McpServerConfig | OpenCodeMcpConfig {
  if (agentConfig.format === 'opencode') {
    return buildOpenCodeMcpConfig(projectPath, devecoPath);
  }
  return buildMcpServerConfig(projectPath, devecoPath);
}