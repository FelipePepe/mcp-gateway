import { randomUUID } from 'crypto';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
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
        return await gateway.callTool(name, (args ?? {}) as Record<string, unknown>);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    });

    return server;
  }

  const app = express();
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

  app.get('/health', (_req, res) => {
    const servers = gateway.serverStatuses;
    const failedServers = servers.filter((server) => server.enabled && !server.connected);

    res.json({
      status: failedServers.length === 0 ? 'ok' : 'degraded',
      servers: gateway.connectedServers,
      serverStatus: servers,
      tools: gateway.listTools().length,
    });
  });

  app.get('/catalog', (_req, res) => {
    res.json({
      servers: gateway.serverStatuses,
      tools: gateway.catalog,
    });
  });

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
