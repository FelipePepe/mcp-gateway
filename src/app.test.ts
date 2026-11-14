import { createServer, request as httpRequest, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createApp,
  parseAllowedHosts,
  parseAuthToken,
  type AppOptions,
  type GatewayApp,
} from './app.js';
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
  /** App options; a function receives the port the harness listens on. */
  appOptions?: AppOptions | ((port: number) => AppOptions);
}

async function start(
  tools: string[] = ['a', 'b'],
  isUp: () => boolean = () => true,
  options: StartOptions = {},
): Promise<Harness> {
  const gateway = new Gateway(options.factory ?? makeFactory(tools, isUp));
  await gateway.connect([fake], FAST);
  // Listen first so options that depend on the port (allowedHosts) can be built.
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const appOptions =
    typeof options.appOptions === 'function' ? options.appOptions(port) : options.appOptions;
  const gatewayApp = createApp(gateway, appOptions);
  httpServer.on('request', gatewayApp.app);
  harness = { gateway, gatewayApp, httpServer, url: `http://127.0.0.1:${port}`, clients: [] };
  return harness;
}

async function connectClient(h: Harness, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${h.url}/mcp`),
      headers ? { requestInit: { headers } } : undefined,
    ),
  );
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

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

/**
 * Request with node:http instead of fetch, which does not let a caller choose
 * the Host header.
 */
function rawRequest(
  h: Harness,
  options: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${h.url}${options.path}`,
      { method: options.method, headers: { ...MCP_HEADERS, ...options.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
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

const TOKEN = 'correct-horse-battery-staple';
const UNAUTHORIZED = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Unauthorized' },
  id: null,
};

describe('createApp bearer token (authToken)', () => {
  const startWithAuth = () => start(['a', 'b'], () => true, { appOptions: { authToken: TOKEN } });
  const BAD_CREDENTIALS: Array<[string, Record<string, string>]> = [
    ['no Authorization header', {}],
    ['a wrong token', { authorization: 'Bearer wrong-token' }],
    ['a token that only shares a prefix', { authorization: `Bearer ${TOKEN}x` }],
    ['another scheme', { authorization: `Basic ${TOKEN}` }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
  ];

  async function expectUnauthorized(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual(UNAUTHORIZED);
  }

  it.each(BAD_CREDENTIALS)('answers 401 on every /mcp method with %s', async (_label, auth) => {
    const h = await startWithAuth();
    const headers = { ...MCP_HEADERS, ...auth };

    await expectUnauthorized(
      await fetch(`${h.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(INITIALIZE) }),
    );
    await expectUnauthorized(await fetch(`${h.url}/mcp`, { method: 'GET', headers }));
    await expectUnauthorized(await fetch(`${h.url}/mcp`, { method: 'DELETE', headers }));
    expect(h.gatewayApp.sessionCount()).toBe(0);
  });

  it.each(BAD_CREDENTIALS)('answers 401 on /catalog with %s', async (_label, auth) => {
    const h = await startWithAuth();
    await expectUnauthorized(await fetch(`${h.url}/catalog`, { headers: auth }));
  });

  it('checks the token before the session lookup and before parsing the body', async () => {
    const h = await startWithAuth();

    // Unknown session ids answer 401, not 404: nothing leaks without a token.
    for (const method of ['POST', 'GET', 'DELETE']) {
      await expectUnauthorized(
        await fetch(`${h.url}/mcp`, {
          method,
          headers: { ...MCP_HEADERS, 'mcp-session-id': 'does-not-exist' },
          body: method === 'POST' ? JSON.stringify(LIST_TOOLS) : undefined,
        }),
      );
    }

    // A malformed body is not even parsed for an unauthenticated caller.
    await expectUnauthorized(
      await fetch(`${h.url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{not json' }),
    );
  });

  it('serves the full round trip and /catalog with the right token', async () => {
    const h = await startWithAuth();
    const client = await connectClient(h, { authorization: `Bearer ${TOKEN}` });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);
    const result = await client.callTool({ name: 'a', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'ok:a' }]);
    expect(h.gatewayApp.sessionCount()).toBe(1);

    // The scheme is case-insensitive (RFC 9110).
    const catalog = await fetch(`${h.url}/catalog`, {
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('www-authenticate')).toBeNull();
    const body = await catalog.json();
    expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['a', 'b']);
  });

  it('keeps /health open but reduces it for unauthenticated callers', async () => {
    const h = await startWithAuth();

    const anonymous = await fetch(`${h.url}/health`);
    expect(anonymous.status).toBe(200);
    // Exactly status and tools: no server names, targets or error strings.
    expect(await anonymous.json()).toEqual({ status: 'ok', tools: 2 });

    const wrong = await fetch(`${h.url}/health`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(200);
    expect(await wrong.json()).toEqual({ status: 'ok', tools: 2 });

    const full = await (
      await fetch(`${h.url}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json();
    expect(full).toMatchObject({ status: 'ok', servers: ['fake'], tools: 2 });
    expect(full.serverStatus[0]).toMatchObject({ name: 'fake', connected: true, tools: 2 });
  });
});

describe('createApp host allow-list (allowedHosts)', () => {
  const startWithHosts = () =>
    start(['a', 'b'], () => true, {
      appOptions: (port) => ({ allowedHosts: [`127.0.0.1:${port}`, 'gateway.test'] }),
    });

  it('serves requests whose Host header is listed', async () => {
    const h = await startWithHosts();
    const client = await connectClient(h);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);

    const other = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'gateway.test' },
      body: INITIALIZE,
    });
    expect(other.status).toBe(200);
  });

  it('answers 403 on every /mcp method for a Host that is not listed', async () => {
    const h = await startWithHosts();
    const forbidden = {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host header: evil.example' },
      id: null,
    };

    const init = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'evil.example' },
      body: INITIALIZE,
    });
    expect(init.status).toBe(403);
    expect(init.json).toEqual(forbidden);
    expect(h.gatewayApp.sessionCount()).toBe(0);

    // Requests that never reach a transport (unknown session) are covered too.
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await rawRequest(h, {
        method,
        path: '/mcp',
        headers: { host: 'evil.example', 'mcp-session-id': 'does-not-exist' },
        body: method === 'POST' ? LIST_TOOLS : undefined,
      });
      expect(res.status).toBe(403);
      expect(res.json).toEqual(forbidden);
    }

    // A live session cannot be driven through another Host either.
    const sessionId = await rawInitialize(h);
    const hijack = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'evil.example', 'mcp-session-id': sessionId },
      body: LIST_TOOLS,
    });
    expect(hijack.status).toBe(403);
  });

  it('rejects the Host before asking for the token when both are enabled', async () => {
    const h = await start(['a'], () => true, {
      appOptions: (port) => ({ authToken: TOKEN, allowedHosts: [`127.0.0.1:${port}`] }),
    });

    const badHost = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` },
      body: INITIALIZE,
    });
    expect(badHost.status).toBe(403);

    const noToken = await post(h, INITIALIZE);
    expect(noToken.status).toBe(401);

    const client = await connectClient(h, { authorization: `Bearer ${TOKEN}` });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['a']);
  });
});

describe('createApp without authToken and allowedHosts', () => {
  it('behaves as before: no token needed, any Host accepted, full /health', async () => {
    const h = await start();

    // An Authorization header is simply ignored.
    const client = await connectClient(h, { authorization: 'Bearer whatever' });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['a', 'b']);

    const otherHost = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'anything.example' },
      body: INITIALIZE,
    });
    expect(otherHost.status).toBe(200);

    const unknown = await post(h, LIST_TOOLS, 'does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('www-authenticate')).toBeNull();

    const catalog = await fetch(`${h.url}/catalog`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('www-authenticate')).toBeNull();

    const health = await (await fetch(`${h.url}/health`)).json();
    expect(Object.keys(health).sort()).toEqual(['serverStatus', 'servers', 'status', 'tools']);
  });

  it('treats an empty allowedHosts list as unset', async () => {
    const h = await start(['a'], () => true, { appOptions: { allowedHosts: [] } });
    const res = await rawRequest(h, {
      method: 'POST',
      path: '/mcp',
      headers: { host: 'anything.example' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(200);
  });
});

describe('createApp /mcp body errors', () => {
  it('answers a JSON-RPC parse error to a malformed JSON body', async () => {
    const h = await start();

    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: '{"jsonrpc": "2.0", "method": ',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(h.gatewayApp.sessionCount()).toBe(0);
  });

  it('answers a JSON-RPC error to a body over the 4mb limit', async () => {
    const h = await start();
    const sessionId = await rawInitialize(h);

    const res = await post(
      h,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'a', arguments: { blob: 'x'.repeat(4 * 1024 * 1024 + 1024) } },
      },
      sessionId,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 }, id: null });
    expect(body.error.message).toMatch(/too large/i);

    // The session is still usable afterwards.
    const after = await post(h, LIST_TOOLS, sessionId);
    expect(after.status).toBe(200);
    await after.body?.cancel();
  });
});

describe('parseAuthToken and parseAllowedHosts', () => {
  it('trims the token and treats an empty one as unset', () => {
    expect(parseAuthToken(undefined)).toBeUndefined();
    expect(parseAuthToken('')).toBeUndefined();
    expect(parseAuthToken('   ')).toBeUndefined();
    expect(parseAuthToken('  s3cret\n')).toBe('s3cret');
  });

  it('splits hosts on commas, trims them and drops empty entries', () => {
    expect(parseAllowedHosts(undefined)).toBeUndefined();
    expect(parseAllowedHosts('')).toBeUndefined();
    expect(parseAllowedHosts(' , ,')).toBeUndefined();
    expect(parseAllowedHosts(' gateway.test:20001 , localhost:20001,,')).toEqual([
      'gateway.test:20001',
      'localhost:20001',
    ]);
  });
});
