import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentTools } from './tools.ts';

export interface McpServerInfo {
  name: string;
  version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 基于 AgentTools 注册表构建 MCP server。
 * JSON-RPC 入口与 MCP 入口共用 tools.ts 的同一份定义，避免两套 schema 漂移。
 */
export function buildMcpServer(tools: AgentTools, info: McpServerInfo = { name: 'automation-cad', version: '0.1.0' }): Server {
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.summaries().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema']
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (!tools.has(name)) {
      return {
        content: [{ type: 'text', text: `未知工具：${name}` }],
        isError: true
      };
    }
    try {
      const result = await tools.call(name, isRecord(args) ? args : {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: isRecord(result) ? result : { value: result },
        isError: isRecord(result) && result.ok === false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `工具执行失败：${message}` }],
        isError: true
      };
    }
  });

  return server;
}
