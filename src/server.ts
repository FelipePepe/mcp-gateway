import { Gateway } from './gateway.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const DEFAULT_PORT = 3001;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    console.error(`[gateway] Invalid PORT "${raw}": expected an integer between 1 and 65535`);
    process.exit(1);
  }
  return port;
}

const PORT = resolvePort(process.env.PORT);

async function main() {
  const config = loadConfig();
  const gateway = new Gateway();
  const { app, closeSessions } = createApp(gateway);

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.error(`[gateway] Listening on http://0.0.0.0:${PORT}/mcp`);
    gateway.connect(config.servers).then(() => {
      console.error(`[gateway] Connected servers: ${gateway.connectedServers.join(', ') || 'none'}`);
      console.error(`[gateway] Total tools: ${gateway.listTools().length}`);
    }).catch(console.error);
  });

  httpServer.on('error', (error) => {
    console.error(`[gateway] HTTP server error: ${error.message}`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[gateway] ${signal} received; shutting down`);

    // Safety net: never hang on a connection or upstream that refuses to close.
    setTimeout(() => {
      console.error(`[gateway] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    httpServer.close();
    closeSessions()
      .catch((error: unknown) => {
        console.error(`[gateway] Failed to close sessions: ${(error as Error).message}`);
      })
      .then(() => {
        gateway.stop();
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[gateway] Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
