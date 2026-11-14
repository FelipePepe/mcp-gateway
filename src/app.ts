import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Gateway } from './gateway.js';

const PROGRESS_HEARTBEAT_INTERVAL_MS = 5_000;

export interface AppOptions {
  /** Interval of the progress heartbeat sent while a tool call is running. */
  heartbeatIntervalMs?: number;
  /**
   * Opt-in bearer token. When set, /mcp and /catalog require
   * `Authorization: Bearer <token>` and /health is reduced for callers
   * without it.
   */
  authToken?: string;
  /**
   * Opt-in Host allow-list (DNS rebinding protection) for /mcp. Entries are
   * matched exactly against the Host header, port included.
   */
  allowedHosts?: string[];
}

/** GATEWAY_TOKEN: trimmed; an empty value means auth is disabled. */
export function parseAuthToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  return token ? token : undefined;
}

/** GATEWAY_ALLOWED_HOSTS: comma separated, trimmed, empty entries dropped. */
export function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export interface GatewayApp {
  app: Express;
  /** Close every live MCP session (used on shutdown). */
  closeSessions(): Promise<void>;
  /** Number of live MCP sessions. */
  sessionCount(): number;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Body-parser failures carry an HTTP status and a `type` discriminator. */
interface BodyParserError {
  status?: number;
  type?: string;
}

function sessionIdOf(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Wrap an async handler so a thrown error becomes an HTTP 500 JSON-RPC error
 * (Express 4 does not catch rejected handlers) instead of a hung request.
 */
function guarded(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gateway] ${req.method} ${req.path} failed: ${message}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  };
}

export function createApp(gateway: Gateway, opts: AppOptions = {}): GatewayApp {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? PROGRESS_HEARTBEAT_INTERVAL_MS;
  // Digest of the expected token: comparing fixed-length digests in constant
  // time leaks neither the token nor its length.
  const authDigest = opts.authToken ? sha256(opts.authToken) : undefined;
  const allowedHosts =
    opts.allowedHosts && opts.allowedHosts.length > 0 ? opts.allowedHosts : undefined;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** MCP Server of each live session, to push server-initiated notifications. */
  const servers = new Map<string, Server>();

  // Tell every live session that the aggregated tool list changed. A session
  // without an open SSE stream, or already closing, is simply skipped.
  const unsubscribeToolsChanged = gateway.onToolsChanged(() => {
    for (const server of servers.values()) {
      server.sendToolListChanged().catch(() => undefined);
    }
  });

  function buildServer(): Server {
    const server = new Server(
      { name: 'mcp-gateway', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: gateway.listTools(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const progressToken = request.params._meta?.progressToken;

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let ticks = 0;
      if (progressToken !== undefined) {
        heartbeat = setInterval(() => {
          ticks++;
          extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: ticks, message: 'Processing…' },
          }).catch(() => {});
        }, heartbeatIntervalMs);
      }

      try {
        // extra.signal aborts when the client cancels the request (or the
        // session closes); the gateway forwards it to the upstream call.
        return await gateway.callTool(name, (args ?? {}) as Record<string, unknown>, {
          signal: extra.signal,
        });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    });

    return server;
  }

  /** Whether the request carries the configured bearer token (true when auth is off). */
  function isAuthorized(req: Request): boolean {
    if (!authDigest) return true;
    const match = /^Bearer +(.+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return false;
    return timingSafeEqual(sha256(match[1]), authDigest);
  }

  const requireAuth: RequestHandler = (req, res, next) => {
    if (isAuthorized(req)) {
      next();
      return;
    }
    res.set('WWW-Authenticate', 'Bearer');
    sendJsonRpcError(res, 401, -32001, 'Unauthorized');
  };

  // The SDK transport validates the Host header too, but unknown-session and
  // non-initialize requests are answered before a transport exists.
  const requireAllowedHost: RequestHandler = (req, res, next) => {
    const host = req.headers.host;
    if (!allowedHosts || (host !== undefined && allowedHosts.includes(host))) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, -32000, `Invalid Host header: ${host}`);
  };

  const app = express();
  // Both checks run before the body is parsed and before any session lookup:
  // a caller that is not allowed in gets nothing else done on its behalf.
  app.use('/mcp', requireAllowedHost, requireAuth);
  app.use(express.json({ limit: '4mb' }));

  app.post('/mcp', guarded(async (req, res) => {
    const sessionId = sessionIdOf(req);

    if (sessionId !== undefined) {
      // A session id the gateway does not know (expired, or from before a
      // restart) must be answered with 404 so the client re-initializes.
      const known = transports.get(sessionId);
      if (!known) {
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await known.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid session id');
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        servers.set(id, server);
      },
    });
    // Set before connect(): the Server chains this handler with its own
    // close handling, so a closed transport also releases its Server.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && transports.get(id) === transport) {
        transports.delete(id);
        servers.delete(id);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));

  // GET opens the standalone SSE stream; DELETE terminates the session. Both
  // go through the transport, which closes itself on DELETE (see onclose).
  const handleSessionRequest = guarded(async (req, res) => {
    const sessionId = sessionIdOf(req);
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (!transport) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  app.get('/health', (req, res) => {
    const servers = gateway.serverStatuses;
    const failedServers = servers.filter((server) => server.enabled && !server.connected);
    const status = failedServers.length === 0 ? 'ok' : 'degraded';
    const tools = gateway.listTools().length;

    // /health stays open for probes, but with auth enabled an unauthenticated
    // caller must not learn server names, targets or error strings.
    if (!isAuthorized(req)) {
      res.json({ status, tools });
      return;
    }

    res.json({
      status,
      servers: gateway.connectedServers,
      serverStatus: servers,
      tools,
    });
  });

  app.get('/catalog', requireAuth, (_req, res) => {
    res.json({
      servers: gateway.serverStatuses,
      tools: gateway.catalog,
    });
  });

  // Body-parser failures on /mcp (malformed JSON, body over the limit) are
  // answered as JSON-RPC errors instead of Express's default HTML page.
  const handleBodyError: ErrorRequestHandler = (error: BodyParserError, req, res, next) => {
    if (res.headersSent || req.path !== '/mcp') {
      next(error);
      return;
    }
    if (error.type === 'entity.parse.failed') {
      sendJsonRpcError(res, 400, -32700, 'Parse error');
    } else if (error.type === 'entity.too.large') {
      sendJsonRpcError(res, 413, -32600, 'Invalid Request: request body too large (limit 4mb)');
    } else if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      sendJsonRpcError(res, error.status, -32600, 'Invalid Request');
    } else {
      next(error);
    }
  };
  app.use(handleBodyError);

  return {
    app,
    closeSessions: async () => {
      unsubscribeToolsChanged();
      const live = Array.from(transports.values());
      await Promise.all(live.map((transport) => transport.close().catch(() => undefined)));
      transports.clear();
      servers.clear();
    },
    sessionCount: () => transports.size,
  };
}
