import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config.js';

interface ToolEntry {
  tool: Tool;
  serverName: string;
  originalName: string;
}

function resolveToolName(server: ServerConfig, originalName: string): string {
  const renamed = server.rename?.[originalName];
  if (renamed && renamed.trim()) {
    return renamed.trim();
  }
  return server.prefix ? `${server.prefix}_${originalName}` : originalName;
}

function decorateDescription(server: ServerConfig, tool: Tool): string {
  const sourceNote =
    server.descriptionPrefix?.trim() || `Provided by the ${server.name} MCP server.`;
  const original = tool.description?.trim();
  return original ? `${sourceNote}

${original}` : sourceNote;
}

export class Gateway {
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, ToolEntry>();
  private timeouts = new Map<string, number>();

  async connect(servers: ServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled !== false);
    await Promise.allSettled(enabled.map((s) => this.connectServer(s)));
  }

  private async connectServer(server: ServerConfig): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('connect timeout after 10s')), 10_000),
    );
    return Promise.race([this._connectServer(server), timeout]);
  }

  private async _connectServer(server: ServerConfig): Promise<void> {
    try {
      const transport =
        server.type === 'http'
          ? new StreamableHTTPClientTransport(new URL(server.url!))
          : server.type === 'sse'
            ? new SSEClientTransport(new URL(server.url!))
            : server.type === 'direct'
              ? new StdioClientTransport({ command: server.cmd![0], args: server.cmd!.slice(1) })
              : new StdioClientTransport({
                  command: 'docker',
                  args: ['exec', '-i', server.container!, ...server.cmd!],
                });

      const client = new Client({ name: 'mcp-gateway', version: '0.1.0' }, { capabilities: {} });

      await client.connect(transport);
      this.clients.set(server.name, client);
      if (server.timeoutMs) this.timeouts.set(server.name, server.timeoutMs);

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const toolName = resolveToolName(server, tool.name);
        this.toolMap.set(toolName, {
          tool: {
            ...tool,
            name: toolName,
            description: decorateDescription(server, tool),
          },
          serverName: server.name,
          originalName: tool.name,
        });
      }

      console.error(`[gateway] ${server.name} — ${tools.length} tool(s) registered`);
    } catch (error) {
      console.error(`[gateway] ${server.name} — failed to connect: ${(error as Error).message}`);
    }
  }

  listTools(): Tool[] {
    return Array.from(this.toolMap.values()).map((e) => e.tool);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const entry = this.toolMap.get(name);
    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const client = this.clients.get(entry.serverName);
    if (!client) {
      return {
        content: [{ type: 'text' as const, text: `Server unavailable: ${entry.serverName}` }],
        isError: true,
      };
    }

    try {
      const timeout = this.timeouts.get(entry.serverName);
      return await client.callTool(
        { name: entry.originalName, arguments: args },
        undefined,
        timeout ? { timeout } : undefined,
      );
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Tool error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }

  get connectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
