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

export interface ServerStatus {
  name: string;
  type: ServerConfig['type'];
  target: string;
  enabled: boolean;
  connected: boolean;
  tools: number;
  error?: string;
  lastConnectedAt?: string;
}

export interface CatalogTool {
  name: string;
  serverName: string;
  originalName: string;
  description?: string;
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
  private statuses = new Map<string, ServerStatus>();

  async connect(servers: ServerConfig[]): Promise<void> {
    this.clients.clear();
    this.toolMap.clear();
    this.timeouts.clear();
    this.statuses.clear();

    for (const server of servers) {
      this.statuses.set(server.name, {
        name: server.name,
        type: server.type,
        target: describeTarget(server),
        enabled: server.enabled !== false,
        connected: false,
        tools: 0,
      });
    }

    const enabled = servers.filter((s) => s.enabled !== false);
    await Promise.allSettled(enabled.map((s) => this.connectServer(s)));
  }

  private async connectServer(server: ServerConfig): Promise<void> {
    const timeoutMs = server.connectTimeoutMs ?? 10_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout after ${timeoutMs}ms`)), timeoutMs),
    );
    try {
      return await Promise.race([this._connectServer(server), timeout]);
    } catch (error) {
      const message = (error as Error).message;
      this.statuses.set(server.name, {
        name: server.name,
        type: server.type,
        target: describeTarget(server),
        enabled: true,
        connected: false,
        tools: 0,
        error: message,
      });
      console.error(`[gateway] ${server.name} — failed to connect: ${message}`);
    }
  }

  private async _connectServer(server: ServerConfig): Promise<void> {
    try {
      const transport = buildTransport(server);

      const client = new Client({ name: 'mcp-gateway', version: '0.1.0' }, { capabilities: {} });

      await client.connect(transport);
      this.clients.set(server.name, client);
      if (server.timeoutMs) this.timeouts.set(server.name, server.timeoutMs);

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const toolName = resolveToolName(server, tool.name);
        if (this.toolMap.has(toolName)) {
          console.error(`[gateway] ${server.name} — tool name collision: ${toolName}`);
        }
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

      this.statuses.set(server.name, {
        name: server.name,
        type: server.type,
        target: describeTarget(server),
        enabled: true,
        connected: true,
        tools: tools.length,
        lastConnectedAt: new Date().toISOString(),
      });
      console.error(`[gateway] ${server.name} — ${tools.length} tool(s) registered`);
    } catch (error) {
      const message = (error as Error).message;
      this.statuses.set(server.name, {
        name: server.name,
        type: server.type,
        target: describeTarget(server),
        enabled: true,
        connected: false,
        tools: 0,
        error: message,
      });
      console.error(`[gateway] ${server.name} — failed to connect: ${message}`);
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

  get serverStatuses(): ServerStatus[] {
    return Array.from(this.statuses.values());
  }

  get catalog(): CatalogTool[] {
    return Array.from(this.toolMap.entries()).map(([name, entry]) => ({
      name,
      serverName: entry.serverName,
      originalName: entry.originalName,
      description: entry.tool.description,
    }));
  }
}

function buildTransport(server: ServerConfig) {
  if (server.type === 'http') {
    return new StreamableHTTPClientTransport(new URL(requireField(server.url, server, 'url')));
  }

  if (server.type === 'sse') {
    return new SSEClientTransport(new URL(requireField(server.url, server, 'url')));
  }

  const cmd = requireField(server.cmd, server, 'cmd');
  if (server.type === 'stdio' && server.container) {
    return new StdioClientTransport({
      command: 'docker',
      args: ['exec', '-i', server.container, ...cmd],
    });
  }

  return new StdioClientTransport({ command: cmd[0], args: cmd.slice(1) });
}

function requireField<T>(value: T | undefined, server: ServerConfig, field: string): T {
  if (value === undefined) {
    throw new Error(`Invalid config for ${server.name}: missing ${field}`);
  }
  return value;
}

function describeTarget(server: ServerConfig): string {
  if (server.url) return server.url;
  if (server.container) return `${server.container}:${server.cmd?.join(' ') ?? ''}`.trim();
  return server.cmd?.join(' ') ?? 'unconfigured';
}
