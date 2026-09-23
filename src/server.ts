import { randomUUID } from 'crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from './gateway.js';
import { loadConfig } from './config.js';

const PROGRESS_HEARTBEAT_INTERVAL_MS = 5_000;

const PORT = parseInt(process.env.PORT ?? '3001', 10);

async function main() {
  const config = loadConfig();
  const gateway = new Gateway();

  const transports = new Map<string, StreamableHTTPServerTransport>();

  function buildServer(): Server {
    const server = new Server(
      { name: 'mcp-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } }
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
        }, PROGRESS_HEARTBEAT_INTERVAL_MS);
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
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      await buildServer().connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: 'No active session — POST /mcp first' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) transports.delete(sessionId);
    res.status(200).end();
  });

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

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`[gateway] Listening on http://0.0.0.0:${PORT}/mcp`);
    gateway.connect(config.servers).then(() => {
      console.error(`[gateway] Connected servers: ${gateway.connectedServers.join(', ') || 'none'}`);
      console.error(`[gateway] Total tools: ${gateway.listTools().length}`);
    }).catch(console.error);
  });
}

main().catch(console.error);
