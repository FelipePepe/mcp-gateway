import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config.js';

/** One connect attempt; `cancelled` is set when it times out. */
interface Attempt {
  cancelled: boolean;
  client?: Client;
}

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

export interface RetryOptions {
  baseMs?: number;
  capMs?: number;
}

export const RETRY_BASE_MS = 2_000;
export const RETRY_CAP_MS = 30_000;
export const DEFAULT_PING_INTERVAL_MS = 30_000;
export const MAX_PING_TIMEOUT_MS = 10_000;

type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it returns true, retrying forever with
 * exponential backoff (base->cap). "Late upstream" is not a permanent
 * failure: the cost of a dead upstream is ~1 attempt/30s per server.
 * Returns true on success, false only if `shouldStop()` became true.
 */
export async function connectWithRetry(
  name: string,
  attempt: () => Promise<boolean>,
  opts: {
    baseMs?: number;
    capMs?: number;
    sleepMs?: SleepFn;
    shouldStop?: () => boolean;
  } = {},
): Promise<boolean> {
  const baseMs = opts.baseMs ?? RETRY_BASE_MS;
  const capMs = opts.capMs ?? RETRY_CAP_MS;
  const sleepMs = opts.sleepMs ?? defaultSleep;
  const shouldStop = opts.shouldStop ?? (() => false);

  let n = 0;
  for (;;) {
    if (shouldStop()) return false;
    n++;
    try {
      if (await attempt()) return true;
    } catch {
      // attempt reported an error: fall through to backoff
    }
    if (shouldStop()) return false;
    const delayMs = Math.min(baseMs * 2 ** (n - 1), capMs);
    console.error(`[gateway] ${name} — reconnect attempt ${n} failed; retrying in ${delayMs}ms`);
    await sleepMs(delayMs);
  }
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
  private stopped = false;
  private retryOptions: RetryOptions = {};
  /** Servers with a reconnect loop in flight (dedupes boot and onclose paths). */
  private reconnecting = new Set<string>();
  private toolsChangedListeners = new Set<() => void>();
  /** Liveness ping timer of each registered client. */
  private pingTimers = new Map<string, NodeJS.Timeout>();
  /** Set by close(): in-flight connect attempts must not register anymore. */
  private closed = false;

  constructor(
    private readonly transportFactory: (server: ServerConfig) => Transport = buildTransport,
  ) {}

  /**
   * Subscribe to changes of the published tool list (an upstream registered
   * or dropped tools). Returns the unsubscribe function.
   */
  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => {
      this.toolsChangedListeners.delete(listener);
    };
  }

  private notifyToolsChanged(): void {
    for (const listener of Array.from(this.toolsChangedListeners)) {
      try {
        listener();
      } catch (error) {
        // A broken listener must never break upstream bookkeeping.
        console.error(`[gateway] tools changed listener failed: ${(error as Error).message}`);
      }
    }
  }

  /** Halt all background reconnect loops (idempotent). */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Shut the gateway down: halt reconnect loops and pings and close every
   * upstream client. Nothing reconnects afterwards.
   */
  async close(): Promise<void> {
    this.stopped = true;
    this.closed = true;
    this.clearPingTimers();

    // Release the clients first so their onclose is ignored by
    // handleDisconnect (no "upstream closed" bookkeeping, no reconnect).
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    const hadTools = this.toolMap.size > 0;
    this.toolMap.clear();
    for (const [name, status] of this.statuses) {
      this.statuses.set(name, { ...status, connected: false, tools: 0 });
    }
    if (hadTools) this.notifyToolsChanged();

    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  private clearPingTimers(): void {
    for (const timer of this.pingTimers.values()) clearInterval(timer);
    this.pingTimers.clear();
  }

  private stopPing(serverName: string): void {
    clearInterval(this.pingTimers.get(serverName));
    this.pingTimers.delete(serverName);
  }

  /**
   * Ping a registered client periodically. HTTP client transports only fire
   * onclose on a local close, so an upstream that restarted would otherwise
   * stay "connected" forever; a failed ping is treated as a disconnect.
   */
  private startPing(server: ServerConfig, client: Client): void {
    this.stopPing(server.name);
    const intervalMs = server.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const timeout = Math.min(intervalMs, MAX_PING_TIMEOUT_MS);
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      client.ping({ timeout }).then(
        () => {
          inFlight = false;
        },
        (error: unknown) => {
          inFlight = false;
          // Ignore pings of clients that were already replaced or released.
          if (this.clients.get(server.name) !== client) return;
          const message = error instanceof Error ? error.message : String(error);
          this.handleDisconnect(server, client, `ping failed: ${message}`);
          void client.close().catch(() => undefined);
        },
      );
    }, intervalMs);
    timer.unref();
    this.pingTimers.set(server.name, timer);
  }

  async connect(servers: ServerConfig[], retry?: RetryOptions): Promise<void> {
    this.clearPingTimers();
    this.clients.clear();
    this.toolMap.clear();
    this.timeouts.clear();
    this.statuses.clear();
    this.retryOptions = retry ?? {};

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

    // Upstreams that were not up at boot (docker-compose start-order races)
    // keep retrying in the background until they answer. connect() must not
    // block on them: the HTTP endpoint keeps serving whatever is available.
    for (const server of enabled) {
      if (this.statuses.get(server.name)?.connected) continue;
      this.scheduleReconnect(server);
    }
  }

  /** Retry an upstream in the background until it answers (one loop per server). */
  private scheduleReconnect(server: ServerConfig): void {
    if (this.stopped || this.reconnecting.has(server.name)) return;
    this.reconnecting.add(server.name);
    void connectWithRetry(server.name, () => this.connectServer(server), {
      baseMs: this.retryOptions.baseMs,
      capMs: this.retryOptions.capMs,
      shouldStop: () => this.stopped,
    })
      .then((ok) => {
        if (ok) console.error(`[gateway] ${server.name} — reconnected, tools registered`);
      })
      .finally(() => this.reconnecting.delete(server.name));
  }

  /** Remove every tool of `serverName`; returns whether any was removed. */
  private dropTools(serverName: string): boolean {
    let dropped = false;
    for (const [toolName, entry] of this.toolMap) {
      if (entry.serverName !== serverName) continue;
      this.toolMap.delete(toolName);
      dropped = true;
    }
    return dropped;
  }

  private handleDisconnect(server: ServerConfig, client: Client, reason = 'upstream closed'): void {
    // Ignore closes from clients that were already replaced or released.
    if (this.clients.get(server.name) !== client) return;
    this.stopPing(server.name);
    this.clients.delete(server.name);
    const dropped = this.dropTools(server.name);
    this.statuses.set(server.name, {
      name: server.name,
      type: server.type,
      target: describeTarget(server),
      enabled: true,
      connected: false,
      tools: 0,
      error: reason,
    });
    console.error(`[gateway] ${server.name} — ${reason}; reconnecting`);
    if (dropped) this.notifyToolsChanged();
    this.scheduleReconnect(server);
  }

  private async connectServer(server: ServerConfig): Promise<boolean> {
    const timeoutMs = server.connectTimeoutMs ?? 10_000;
    const attempt: Attempt = { cancelled: false };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Cancel the in-flight attempt so a late success cannot register
        // itself, and release its client/transport.
        attempt.cancelled = true;
        void attempt.client?.close().catch(() => undefined);
        reject(new Error(`connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this._connectServer(server, attempt), timeout]);
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
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async _connectServer(server: ServerConfig, attempt: Attempt): Promise<boolean> {
    let client: Client | undefined;
    try {
      const transport = this.transportFactory(server);

      client = new Client({ name: 'mcp-gateway', version: '0.1.0' }, { capabilities: {} });
      attempt.client = client;

      // Register the client only once connect AND listTools both succeeded,
      // so a half-connected upstream is never reported as up.
      await client.connect(transport);
      const { tools } = await client.listTools();

      if (attempt.cancelled) {
        // Timed out while in flight (the timer already closed the client).
        return false;
      }
      if (this.closed) {
        // close() ran while this attempt was in flight: release it.
        await client.close().catch(() => undefined);
        return false;
      }

      const dropped = this.dropTools(server.name);
      this.clients.set(server.name, client);
      const live = client;
      live.onclose = () => this.handleDisconnect(server, live);
      this.startPing(server, live);
      if (server.timeoutMs) this.timeouts.set(server.name, server.timeoutMs);

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
      if (dropped || tools.length > 0) this.notifyToolsChanged();
      return true;
    } catch (error) {
      if (attempt.cancelled) return false; // timeout path already closed it and reported
      await client?.close().catch(() => undefined);
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
      return false;
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
