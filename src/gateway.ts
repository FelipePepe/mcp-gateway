import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
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
  /** Tools of this server that are registered (published) right now. */
  tools: number;
  /** Tools left out because another server owns their name; absent when none. */
  skippedTools?: string[];
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
/** Upper bound of tools/list pages read from one upstream. */
export const MAX_TOOL_LIST_PAGES = 50;
/** The retry delay is spread by up to this fraction, in either direction. */
export const RETRY_JITTER_RATIO = 0.2;

type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it returns true, retrying forever with
 * exponential backoff (base->cap). "Late upstream" is not a permanent
 * failure: the cost of a dead upstream is ~1 attempt/30s per server.
 * Returns true on success, false only if `shouldStop()` became true.
 *
 * Each delay gets up to ±20% jitter (never above `capMs`) so upstreams that
 * went down together do not retry in lockstep. A failed attempt is logged
 * only when its number is a power of two: a permanently dead upstream then
 * logs less and less instead of one line per retry.
 */
export async function connectWithRetry(
  name: string,
  attempt: () => Promise<boolean>,
  opts: {
    baseMs?: number;
    capMs?: number;
    sleepMs?: SleepFn;
    shouldStop?: () => boolean;
    /** Source of the jitter, in [0, 1); defaults to `Math.random`. */
    random?: () => number;
  } = {},
): Promise<boolean> {
  const baseMs = opts.baseMs ?? RETRY_BASE_MS;
  const capMs = opts.capMs ?? RETRY_CAP_MS;
  const sleepMs = opts.sleepMs ?? defaultSleep;
  const shouldStop = opts.shouldStop ?? (() => false);
  const random = opts.random ?? Math.random;

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
    const nominalMs = Math.min(baseMs * 2 ** (n - 1), capMs);
    const jitter = 1 + (random() * 2 - 1) * RETRY_JITTER_RATIO;
    const delayMs = Math.min(Math.round(nominalMs * jitter), capMs);
    if ((n & (n - 1)) === 0) {
      console.error(`[gateway] ${name} — reconnect attempt ${n} failed; retrying in ${delayMs}ms`);
    }
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

/**
 * Read the whole tool list of an upstream, following `nextCursor`. A cursor
 * the upstream already handed out, or the page cap, ends the walk so a
 * misbehaving upstream cannot keep the gateway listing forever.
 */
async function listAllTools(serverName: string, client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor)) {
      console.error(`[gateway] ${serverName} — tools/list repeated a cursor; stopping at page ${page}`);
      break;
    }
    if (page >= MAX_TOOL_LIST_PAGES) {
      console.error(
        `[gateway] ${serverName} — tools/list page cap (${MAX_TOOL_LIST_PAGES}) reached; remaining tools ignored`,
      );
      break;
    }
    seen.add(cursor);
  }
  return tools;
}

export class Gateway {
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, ToolEntry>();
  /**
   * Tools of each connected server that lost their name to another server,
   * by resolved name. Kept so the name can be handed back when its owner
   * disconnects.
   */
  private skippedTools = new Map<string, Map<string, ToolEntry>>();
  /** Position of each server in the configured list: lower wins a collision. */
  private priority = new Map<string, number>();
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
    this.skippedTools.clear();
    for (const [name, status] of this.statuses) {
      const { skippedTools: _released, ...rest } = status;
      this.statuses.set(name, { ...rest, connected: false, tools: 0 });
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
    this.skippedTools.clear();
    this.priority.clear();
    this.timeouts.clear();
    this.statuses.clear();
    this.retryOptions = retry ?? {};

    servers.forEach((server, index) => {
      // Config order is the collision priority; a repeated name keeps its
      // first position.
      if (!this.priority.has(server.name)) this.priority.set(server.name, index);
      this.statuses.set(server.name, this.buildStatus(server, { connected: false }));
    });

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

  /** Registered and skipped tools of a server, as reported in its status. */
  private toolCounters(serverName: string): Pick<ServerStatus, 'tools' | 'skippedTools'> {
    const skipped = Array.from(this.skippedTools.get(serverName)?.keys() ?? []);
    let tools = 0;
    for (const entry of this.toolMap.values()) {
      if (entry.serverName === serverName) tools++;
    }
    return { tools, ...(skipped.length > 0 ? { skippedTools: skipped } : {}) };
  }

  /**
   * Single place that builds a ServerStatus. The tool counters of a connected
   * server are derived from the routing tables, so they always match what is
   * published.
   */
  private buildStatus(
    server: ServerConfig,
    state: { connected: boolean; error?: string; lastConnectedAt?: string },
  ): ServerStatus {
    return {
      name: server.name,
      type: server.type,
      target: describeTarget(server),
      enabled: server.enabled !== false,
      connected: state.connected,
      ...(state.connected ? this.toolCounters(server.name) : { tools: 0 }),
      ...(state.error !== undefined ? { error: state.error } : {}),
      ...(state.lastConnectedAt !== undefined ? { lastConnectedAt: state.lastConnectedAt } : {}),
    };
  }

  /** Recompute the tool counters of a server whose registered tools changed. */
  private refreshToolCounts(serverName: string): void {
    const status = this.statuses.get(serverName);
    if (!status) return;
    const { skippedTools: _previous, ...rest } = status;
    this.statuses.set(serverName, { ...rest, ...this.toolCounters(serverName) });
  }

  /** Remember that `entry` of `serverName` is not published (logged once). */
  private skipTool(serverName: string, toolName: string, entry: ToolEntry, owner: string): void {
    let skipped = this.skippedTools.get(serverName);
    if (!skipped) {
      skipped = new Map();
      this.skippedTools.set(serverName, skipped);
    }
    skipped.set(toolName, entry);
    console.error(
      `[gateway] ${serverName} — tool name collision, skipped: ${toolName} (owned by ${owner})`,
    );
  }

  /**
   * Publish the tools of `server`. A name owned by a different server stays
   * with whichever of the two comes first in the configured list, so the
   * winner does not depend on connection order; the loser's tool is skipped
   * and reported in its status. Returns how many tools were registered.
   */
  private registerTools(server: ServerConfig, tools: Tool[]): number {
    const rank = (name: string) => this.priority.get(name) ?? Number.MAX_SAFE_INTEGER;
    const demoted = new Set<string>();
    let registered = 0;

    for (const tool of tools) {
      const toolName = resolveToolName(server, tool.name);
      const entry: ToolEntry = {
        tool: {
          ...tool,
          name: toolName,
          description: decorateDescription(server, tool),
        },
        serverName: server.name,
        originalName: tool.name,
      };

      const owner = this.toolMap.get(toolName);
      if (owner && owner.serverName !== server.name) {
        if (rank(owner.serverName) <= rank(server.name)) {
          this.skipTool(server.name, toolName, entry, owner.serverName);
          continue;
        }
        // The current owner is configured later: this server takes the name.
        this.skipTool(owner.serverName, toolName, owner, server.name);
        demoted.add(owner.serverName);
      }
      if (!owner || owner.serverName !== server.name) registered++;
      this.toolMap.set(toolName, entry);
    }

    for (const name of demoted) this.refreshToolCounts(name);
    return registered;
  }

  /**
   * Give skipped tools whose name is free again (its owner dropped it) back
   * to the servers that had skipped them, in config order. Returns whether
   * any tool was published.
   */
  private reclaimSkippedTools(): boolean {
    const candidates = Array.from(this.skippedTools.keys()).sort(
      (a, b) =>
        (this.priority.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (this.priority.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    let reclaimed = false;
    for (const serverName of candidates) {
      const skipped = this.skippedTools.get(serverName);
      if (!skipped) continue;
      let changed = false;
      for (const [toolName, entry] of Array.from(skipped)) {
        if (this.toolMap.has(toolName)) continue;
        this.toolMap.set(toolName, entry);
        skipped.delete(toolName);
        changed = true;
      }
      if (skipped.size === 0) this.skippedTools.delete(serverName);
      if (!changed) continue;
      reclaimed = true;
      this.refreshToolCounts(serverName);
    }
    return reclaimed;
  }

  /**
   * Remove every tool of `serverName`, registered or skipped; returns whether
   * any registered tool was removed.
   */
  private dropTools(serverName: string): boolean {
    this.skippedTools.delete(serverName);
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
    // Names this server owned may now go to a server that had skipped them.
    this.reclaimSkippedTools();
    this.statuses.set(server.name, this.buildStatus(server, { connected: false, error: reason }));
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
      this.statuses.set(server.name, this.buildStatus(server, { connected: false, error: message }));
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
      const tools = await listAllTools(server.name, client);

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

      const registered = this.registerTools(server, tools);
      // Names this server no longer offers may go to a server that skipped them.
      const reclaimed = this.reclaimSkippedTools();

      this.statuses.set(
        server.name,
        this.buildStatus(server, { connected: true, lastConnectedAt: new Date().toISOString() }),
      );
      console.error(`[gateway] ${server.name} — ${registered} tool(s) registered`);
      if (dropped || registered > 0 || reclaimed) this.notifyToolsChanged();
      return true;
    } catch (error) {
      if (attempt.cancelled) return false; // timeout path already closed it and reported
      await client?.close().catch(() => undefined);
      const message = (error as Error).message;
      this.statuses.set(server.name, this.buildStatus(server, { connected: false, error: message }));
      console.error(`[gateway] ${server.name} — failed to connect: ${message}`);
      return false;
    }
  }

  listTools(): Tool[] {
    return Array.from(this.toolMap.values()).map((e) => e.tool);
  }

  /**
   * Route a tool call to its upstream. `opts.signal` is forwarded so a client
   * cancellation also cancels the upstream request; a call aborted that way
   * rejects (nobody is waiting for a result) instead of answering an error.
   */
  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}) {
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
      const options: RequestOptions = {};
      if (timeout) options.timeout = timeout;
      if (opts.signal) options.signal = opts.signal;
      return await client.callTool(
        { name: entry.originalName, arguments: args },
        undefined,
        timeout || opts.signal ? options : undefined,
      );
    } catch (error) {
      // The caller already cancelled: it must not get a "Tool error" result.
      if (opts.signal?.aborted) throw error;
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
