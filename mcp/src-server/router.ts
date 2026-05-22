/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Tool definition interface
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

/**
 * Tool handler interface
 */
export interface ToolHandler {
  (args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/**
 * Registered tool entry
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRouter {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Add a tool to the router
   */
  add(definition: ToolDefinition, handler: ToolHandler): this {
    this.tools.set(definition.name, { definition, handler });
    return this;
  }

  /**
   * Get all registered tools
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register all tools to an MCP server
   */
  registerToServer(server: McpServer): void {
    for (const { definition, handler } of this.getAll()) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema as never,
        },
        (async (args: Record<string, unknown>) => {
          return handler(args);
        }) as never
      );
    }
  }
}

/**
 * Create a new tool router
 */
export function createToolRouter(): ToolRouter {
  return new ToolRouter();
}