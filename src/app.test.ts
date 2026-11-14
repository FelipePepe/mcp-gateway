import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp, type AppOptions, type GatewayApp } from './app.js';
import { Gateway } from './gateway.js';
import type { ServerConfig } from './config.js';

const fake: ServerConfig = { name: 'fake', type: 'http', url: 'http://unused', enabled: true };
const FAST = { baseMs: 5, capMs: 10 };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '0.0.0' },
  },
};
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/**
 * In-memory upstream factory: every call is one connect attempt. While
 * `isUp()` is false the upstream is unreachable and the attempt fails.
 */
function makeFactory(
  tools: string[],
  isUp: () => boolean = () => true,
): (server: ServerConfig) => Transport {
  return () => {
    if (!isUp()) throw new Error('upstream down');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'fake', version: '0.0.0' });
    for (const name of tools) {
      server.registerTool(name, { description: `tool ${name}` }, async () => ({
        content: [{ type: 'text' as const, text: `ok:${name}` }],
      }));
    }
    void server.connect(serverSide);
    return clientSide;
  };
}

interface Harness {
  gateway: Gateway;
  gatewayApp: GatewayApp;
  httpServer: HttpServer;
  url: string;
  clients: Client[];
}

let harness: Harness | undefined;

interface StartOptions {
  /** Upstream transport factory; defaults to `makeFactory(tools, isUp)`. */
  factory?: (server: ServerConfig) => Transport;
  appOptions?: AppOptions;
}

async function start(
  tools: string[] = ['a', 'b'],
  isUp: () => boolean = () => true,
  options: StartOptions = {},
): Promise<Harness> {
  const gateway = new Gateway(options.factory ?? makeFactory(tools, isUp));
  await gateway.connect([fake], FAST);
  const gatewayApp = createApp(gateway, options.appOptions);
  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = gatewayApp.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  harness = { gateway, gatewayApp, httpServer, url: `http://127.0.0.1:${port}`, clients: [] };
  return harness;
}

async function connectClient(h: Harness): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`)));
  h.clients.push(client);
  return client;
}

/** POST a JSON-RPC message with raw fetch. */
function post(h: Harness, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`${h.url}/mcp`, {
    method: 'POST',
    headers: sessionId ? { ...MCP_HEADERS, 'mcp-session-id': sessionId } : MCP_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Open a session with raw fetch and return its id. */
async function rawInitialize(h: Harness): Promise<string> {
  const res = await post(h, INITIALIZE);
  expect(res.status).toBe(200);
  await res.body?.cancel();
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

const SESSION_NOT_FOUND = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Session not found' },
  id: null,
};

afterEach(async () => {
  vi.restoreAllMocks();
  const h = harness;
  harness = undefined;
  if (!h) return;
  await Promise.all(h.clients.map((c) => c.close().catch(() => undefined)));
  await h.gatewayApp.closeSessions();
  h.gateway.stop();
  h.httpServer.closeAllConnections();
  await new Promise<void>((resolve) => h.httpServer.close(() => resolve()));
});

describe('createApp /mcp', () => {
  it('serves a full round trip: initialize, list tools and call a tool', async () => {
    const h = await start();
    const client = await connectClient(h);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);

    const result = await client.callTool({ name: 'a', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'ok:a' }]);
    expect(h.gatewayApp.sessionCount()).toBe(1);
  });

  it('answers 404 to a POST with an unknown session id and creates no session', async () => {
    const h = await start();

    const res = await post(h, LIST_TOOLS, 'does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
    expect(h.gatewayApp.sessionCount()).toBe(0);

    // Even an initialize request must not revive an unknown session id.
    const init = await post(h, INITIALIZE, 'does-not-exist');
    expect(init.status).toBe(404);
    expect(h.gatewayApp.sessionCount()).toBe(0);
  });

  it('answers 400 to a non-initialize POST without a session id', async () => {
    const h = await start();

    const res = await post(h, LIST_TOOLS);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session id' },
      id: null,
    });
    expect(h.gatewayApp.sessionCount()).toBe(0);
  });

  it('answers 404 to GET and DELETE with a missing or unknown session id', async () => {
    const h = await start();

    for (const method of ['GET', 'DELETE']) {
      const missing = await fetch(`${h.url}/mcp`, { method, headers: MCP_HEADERS });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(SESSION_NOT_FOUND);

      const unknown = await fetch(`${h.url}/mcp`, {
        method,
        headers: { ...MCP_HEADERS, 'mcp-session-id': 'does-not-exist' },
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual(SESSION_NOT_FOUND);
    }
  });

  it('releases the session on DELETE and answers 404 to that id afterwards', async () => {
    const h = await start();
    const sessionId = await rawInitialize(h);
    expect(h.gatewayApp.sessionCount()).toBe(1);

    const del = await fetch(`${h.url}/mcp`, {
      method: 'DELETE',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    });
    expect(del.status).toBe(200);
    expect(h.gatewayApp.sessionCount()).toBe(0);

    const after = await post(h, LIST_TOOLS, sessionId);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual(SESSION_NOT_FOUND);
    expect(h.gatewayApp.sessionCount()).toBe(0);
  });

  it('releases every session on closeSessions()', async () => {
    const h = await start();
    const first = await rawInitialize(h);
    await rawInitialize(h);
    expect(h.gatewayApp.sessionCount()).toBe(2);

    await h.gatewayApp.closeSessions();
    expect(h.gatewayApp.sessionCount()).toBe(0);

    const after = await post(h, LIST_TOOLS, first);
    expect(after.status).toBe(404);
  });

  it('answers 500 with a JSON-RPC error when a handler throws', async () => {
    const h = await start();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(
      new Error('boom'),
    );

    const res = await post(h, INITIALIZE);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
    expect(errorLog.mock.calls.some((args) => String(args[0]).includes('boom'))).toBe(true);

    // The app keeps serving after the failure.
    const health = await fetch(`${h.url}/health`);
    expect(health.status).toBe(200);
  });

  it('accepts a request body larger than 100kB', async () => {
    const h = await start();
    const client = await connectClient(h);

    const result = await client.callTool({
      name: 'a',
      arguments: { blob: 'x'.repeat(300_000) },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'ok:a' }]);
  });
});

describe('createApp tool call cancellation', () => {
  it('forwards a client cancellation to the upstream tool call', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const upstreamCancelled = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const h = await start([], () => true, {
      factory: () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const server = new McpServer({ name: 'slow', version: '0.0.0' });
        server.registerTool('slow', { description: 'never answers' }, async (extra) => {
          started();
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener('abort', () => resolve());
          });
          cancelled();
          return { content: [{ type: 'text' as const, text: 'late' }] };
        });
        void server.connect(serverSide);
        return clientSide;
      },
    });
    const client = await connectClient(h);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = new AbortController();
    const call = client.callTool({ name: 'slow', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    const outcome = call.then(
      () => 'resolved',
      () => 'rejected',
    );
    await upstreamStarted;
    controller.abort(new Error('user cancelled'));

    // The cancellation travels client -> gateway -> upstream handler.
    await upstreamCancelled;
    expect(await outcome).toBe('rejected');

    // A cancelled call is not an error worth logging, and the session survives.
    expect(errorLog.mock.calls).toEqual([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['slow']);
  });
});

describe('createApp tool list change notifications', () => {
  it('advertises tools.listChanged', async () => {
    const h = await start();
    const client = await connectClient(h);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
  });

  it('notifies a connected client when an upstream that was down comes up', async () => {
    let upstreamUp = false;
    const h = await start(['a', 'b'], () => upstreamUp);

    // Server-initiated notifications travel over the standalone GET SSE
    // stream, which the SDK client opens in the background after initialize:
    // watch its fetch to know when that stream is established.
    let sseOpened!: () => void;
    const sseOpen = new Promise<void>((resolve) => {
      sseOpened = resolve;
    });
    const watchingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (init?.method === 'GET' && res.ok) sseOpened();
      return res;
    };

    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    let notified!: () => void;
    const notification = new Promise<void>((resolve) => {
      notified = resolve;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => notified());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { fetch: watchingFetch }),
    );
    h.clients.push(client);

    await sseOpen;
    expect((await client.listTools()).tools).toEqual([]);

    upstreamUp = true;
    await notification;

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  it('unsubscribes from the gateway on closeSessions()', async () => {
    const unsubscribe = vi.fn();
    const subscribe = Gateway.prototype.onToolsChanged;
    vi.spyOn(Gateway.prototype, 'onToolsChanged').mockImplementation(function (
      this: Gateway,
      listener: () => void,
    ) {
      return unsubscribe.mockImplementation(subscribe.call(this, listener));
    });

    const h = await start();
    expect(unsubscribe).not.toHaveBeenCalled();

    await h.gatewayApp.closeSessions();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('createApp /health and /catalog', () => {
  it('reports upstream status and the published tools', async () => {
    const h = await start();

    const health = await (await fetch(`${h.url}/health`)).json();
    expect(health).toMatchObject({ status: 'ok', servers: ['fake'], tools: 2 });
    expect(health.serverStatus[0]).toMatchObject({ name: 'fake', connected: true, tools: 2 });

    const catalog = await (await fetch(`${h.url}/catalog`)).json();
    expect(catalog.servers[0]).toMatchObject({ name: 'fake', connected: true });
    expect(catalog.tools.map((t: { name: string }) => t.name).sort()).toEqual(['a', 'b']);
  });
});
