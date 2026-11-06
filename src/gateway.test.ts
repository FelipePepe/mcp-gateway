import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { connectWithRetry, Gateway, type RetryOptions } from './gateway.js';
import type { ServerConfig } from './config.js';

interface AttemptPlan {
  /** Tool names to register; `null` leaves tools/list unhandled (it errors). */
  tools: string[] | null;
  /** Delay before the upstream starts answering, in ms. */
  delayMs?: number;
}

interface Upstream {
  factory: (server: ServerConfig) => Transport;
  /** Client-side transports handed to the gateway, one per attempt. */
  transports: Transport[];
  /** Upstream servers, one per attempt. */
  servers: McpServer[];
  closeSpies: ReturnType<typeof vi.fn>[];
}

/** In-memory upstream: every factory call is one connect attempt. */
function makeUpstream(plan: (attempt: number) => AttemptPlan): Upstream {
  const up: Upstream = {
    transports: [],
    servers: [],
    closeSpies: [],
    factory: () => {
      const attempt = up.transports.length + 1;
      const { tools, delayMs } = plan(attempt);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'fake', version: '0.0.0' });
      for (const name of tools ?? []) {
        server.registerTool(name, { description: `tool ${name}` }, async () => ({
          content: [{ type: 'text' as const, text: `ok:${name}` }],
        }));
      }
      if (delayMs) setTimeout(() => void server.connect(serverSide), delayMs);
      else void server.connect(serverSide);
      const closeSpy = vi.fn();
      const realClose = clientSide.close.bind(clientSide);
      let closed = false;
      clientSide.close = async () => {
        // InMemoryTransport re-enters close() through its peer; count once.
        if (!closed) closeSpy();
        closed = true;
        await realClose();
      };
      up.transports.push(clientSide);
      up.servers.push(server);
      up.closeSpies.push(closeSpy);
      return clientSide;
    },
  };
  return up;
}

const fake: ServerConfig = { name: 'fake', type: 'http', url: 'http://unused' };
const FAST = { baseMs: 5, capMs: 10 };

describe('connectWithRetry', () => {
  it('succeeds when the attempt succeeds on the third try', async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      'test-srv',
      async () => {
        calls++;
        return calls >= 3;
      },
      { baseMs: 1, capMs: 4 },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('backs off exponentially with the cap and stops when told', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const ok = await connectWithRetry(
      'x',
      () => {
        attempts++;
        return Promise.resolve(false);
      },
      {
        baseMs: 10,
        capMs: 25,
        sleepMs: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        shouldStop: () => attempts >= 5,
      },
    );
    expect(ok).toBe(false);
    expect(attempts).toBe(5);
    // 10, 20, then capped at 25
    expect(sleeps).toEqual([10, 20, 25, 25]);
  });

  it('swallows thrown attempts and keeps retrying', async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      'thrower',
      async () => {
        calls++;
        if (calls === 1) throw new Error('fetch failed');
        return true;
      },
      { baseMs: 1 },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('Gateway reconnect loop', () => {
  it('keeps retrying an unreachable upstream until stop() halts it', async () => {
    const gw = new Gateway();
    const connectServer = vi
      .spyOn(gw as unknown as { connectServer: (s: never) => Promise<void> }, 'connectServer');

    await gw.connect(
      [
        {
          name: 'dead',
          type: 'http',
          url: 'http://127.0.0.1:59999/mcp',
        },
      ],
      { baseMs: 10, capMs: 50 },
    );

    // initial connect finished (retries may already be racing — only >=1 is
    // guaranteed at this point)
    expect(connectServer.mock.calls.length).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => {
      expect(connectServer.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    const status = gw.serverStatuses.find((s) => s.name === 'dead')!;
    expect(status.connected).toBe(false);
    expect(status.error).toBeDefined();

    await gw.stop();
    // Let any in-flight iteration finish, then require the count to converge
    // (stop() halts the loop, so calls must stop accumulating).
    let prev = connectServer.mock.calls.length;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const cur = connectServer.mock.calls.length;
      if (cur === prev) break;
      prev = cur;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(connectServer.mock.calls.length).toBe(prev);
  }, 10_000);
});

describe('Gateway upstream lifecycle', () => {
  it('registers tools through an injected transport factory', async () => {
    const up = makeUpstream(() => ({ tools: ['a', 'b'] }));
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    gw.stop();

    expect(gw.listTools().map((t) => t.name).sort()).toEqual(['a', 'b']);
    expect(gw.connectedServers).toEqual(['fake']);
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 2 });
  });

  it('does not report success when listTools fails, and keeps retrying', async () => {
    const up = makeUpstream((n) => ({ tools: n === 1 ? null : ['a'] }));
    const gw = new Gateway(up.factory);
    await gw.connect([fake], { baseMs: 30, capMs: 30 });

    // First attempt connected but listTools failed: nothing may be registered.
    expect(gw.connectedServers).toEqual([]);
    expect(gw.listTools()).toEqual([]);
    expect(gw.serverStatuses[0]).toMatchObject({ connected: false, tools: 0 });
    expect(gw.serverStatuses[0].error).toBeDefined();
    expect(up.closeSpies[0]).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 1 });
    });
    expect(gw.connectedServers).toEqual(['fake']);
    expect(up.transports.length).toBe(2);
    gw.stop();
  });

  it('closes a connect attempt that exceeds connectTimeoutMs and ignores its late success', async () => {
    const up = makeUpstream((n) => (n === 1 ? { tools: ['a'], delayMs: 120 } : { tools: ['a'] }));
    const gw = new Gateway(up.factory);
    await gw.connect([{ ...fake, connectTimeoutMs: 30 }], FAST);

    expect(gw.serverStatuses[0].connected).toBe(false);
    expect(up.closeSpies[0]).toHaveBeenCalled();

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(true));
    // Let the slow first attempt finish answering, then check it did not win.
    await new Promise((r) => setTimeout(r, 250));
    gw.stop();

    expect(up.transports.length).toBe(2);
    expect(gw.connectedServers).toEqual(['fake']);
    expect(gw.listTools().map((t) => t.name)).toEqual(['a']);
    expect(up.servers[1].isConnected()).toBe(true);
    expect(up.closeSpies[1]).not.toHaveBeenCalled();
  });

  it('detects a closed upstream, drops its tools and reconnects', async () => {
    // Attempt 2 answers slowly so the disconnected state is observable.
    const up = makeUpstream((n) => (n === 1 ? { tools: ['a', 'b'] } : { tools: ['a', 'b'], delayMs: 150 }));
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 2 });

    await up.servers[0].close();

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    expect(gw.serverStatuses[0].error).toBe('upstream closed');
    expect(gw.connectedServers).toEqual([]);
    expect(gw.listTools()).toEqual([]);
    const down = await gw.callTool('a', {});
    expect(down.isError).toBe(true);

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(true));
    expect(gw.listTools().map((t) => t.name).sort()).toEqual(['a', 'b']);
    expect(gw.connectedServers).toEqual(['fake']);
    const up2 = await gw.callTool('a', {});
    expect(up2.isError).toBeFalsy();
    expect(up.transports.length).toBe(2);
    gw.stop();
  });

  it('does not reconnect after stop()', async () => {
    const up = makeUpstream(() => ({ tools: ['a'] }));
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    gw.stop();
    await up.servers[0].close();

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    await new Promise((r) => setTimeout(r, 100));
    expect(up.transports.length).toBe(1);
  });
});
