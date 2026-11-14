import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { connectWithRetry, Gateway, MAX_TOOL_LIST_PAGES } from './gateway.js';
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
        // 0.5 is the midpoint of the jitter range: the delay is left untouched.
        random: () => 0.5,
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

  /** Run `failures` failed attempts and return the delays that were slept. */
  async function sleepsOf(
    failures: number,
    opts: { baseMs: number; capMs: number; random?: () => number },
  ): Promise<number[]> {
    const sleeps: number[] = [];
    let attempts = 0;
    await connectWithRetry(
      'jitter',
      () => {
        attempts++;
        return Promise.resolve(false);
      },
      {
        ...opts,
        sleepMs: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        shouldStop: () => attempts > failures,
      },
    );
    return sleeps.slice(0, failures);
  }

  it('applies up to ±20% jitter to the delay, still capped at capMs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // random() = 0 is the lower bound (-20%), random() -> 1 the upper (+20%).
      expect(await sleepsOf(4, { baseMs: 100, capMs: 1000, random: () => 0 })).toEqual([
        80, 160, 320, 640,
      ]);
      expect(await sleepsOf(5, { baseMs: 100, capMs: 1000, random: () => 1 })).toEqual([
        120, 240, 480, 960, 1000,
      ]);

      // Default random source: every delay stays inside the jitter window.
      const sleeps = await sleepsOf(8, { baseMs: 100, capMs: 1000 });
      expect(sleeps).toHaveLength(8);
      sleeps.forEach((ms, i) => {
        const nominal = Math.min(100 * 2 ** i, 1000);
        expect(ms).toBeGreaterThanOrEqual(nominal * 0.8);
        expect(ms).toBeLessThanOrEqual(Math.min(nominal * 1.2, 1000));
      });
      // The jitter is real: the nominal sequence is not reproduced exactly.
      expect(sleeps.slice(0, 4)).not.toEqual([100, 200, 400, 800]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('logs failed attempts only when the attempt number is a power of two', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await sleepsOf(9, { baseMs: 1, capMs: 2, random: () => 0.5 });
      const logged = errorLog.mock.calls
        .map((args) => /reconnect attempt (\d+) failed/.exec(String(args[0]))?.[1])
        .filter((n) => n !== undefined);
      expect(logged).toEqual(['1', '2', '4', '8']);
    } finally {
      vi.restoreAllMocks();
    }
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

describe('Gateway tool list change notifications', () => {
  it('notifies on register, on upstream close and again on reconnect, until unsubscribed', async () => {
    const up = makeUpstream(() => ({ tools: ['a', 'b'] }));
    const gw = new Gateway(up.factory);
    const listener = vi.fn();
    const unsubscribe = gw.onToolsChanged(listener);

    await gw.connect([fake], { baseMs: 40, capMs: 40 });
    expect(listener).toHaveBeenCalledTimes(1);

    await up.servers[0].close();
    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    expect(listener).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(true));
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    gw.stop();
    await up.servers[1].close();
    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    expect(gw.listTools()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not notify when the tool list did not change', async () => {
    // An upstream that publishes an empty tool list (McpServer only answers
    // tools/list once a tool is registered, so use the low-level Server).
    const upstream = new Server(
      { name: 'empty', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const gw = new Gateway(() => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void upstream.connect(serverSide);
      return clientSide;
    });
    const listener = vi.fn();
    gw.onToolsChanged(listener);

    await gw.connect([fake], FAST);
    gw.stop();
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 0 });

    await upstream.close();
    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a listener that throws and still notifies the others', async () => {
    const up = makeUpstream(() => ({ tools: ['a'] }));
    const gw = new Gateway(up.factory);
    const healthy = vi.fn();
    gw.onToolsChanged(() => {
      throw new Error('listener exploded');
    });
    gw.onToolsChanged(healthy);

    await gw.connect([fake], FAST);
    gw.stop();

    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 1 });
    expect(gw.listTools().map((t) => t.name)).toEqual(['a']);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

describe('Gateway upstream liveness', () => {
  /** Count the pings the gateway sends through a client-side transport. */
  function countPings(transport: Transport): () => number {
    let pings = 0;
    const realSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ('method' in message && message.method === 'ping') pings++;
      await realSend(message, options);
    };
    return () => pings;
  }

  it('pings a healthy upstream periodically and keeps it connected', async () => {
    const up = makeUpstream(() => ({ tools: ['a'] }));
    const gw = new Gateway(up.factory);
    await gw.connect([{ ...fake, pingIntervalMs: 10 }], FAST);
    const pings = countPings(up.transports[0]);

    await vi.waitFor(() => expect(pings()).toBeGreaterThanOrEqual(3));
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 1 });
    expect(up.transports.length).toBe(1);

    // close() clears the ping timer: no ping may be sent afterwards.
    await gw.close();
    const afterClose = pings();
    await new Promise((r) => setTimeout(r, 60));
    expect(pings()).toBe(afterClose);
  });

  it('detects an upstream that stops answering pings, drops its tools and reconnects', async () => {
    // Attempt 2 answers slowly so the disconnected state is observable.
    const up = makeUpstream((n) => (n === 1 ? { tools: ['a', 'b'] } : { tools: ['a', 'b'], delayMs: 150 }));
    const gw = new Gateway(up.factory);
    await gw.connect([{ ...fake, pingIntervalMs: 20 }], FAST);
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 2 });

    // The upstream goes silent: messages are lost but nothing closes the
    // connection, which is what a restarted HTTP upstream looks like.
    up.transports[0].send = async () => undefined;

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(false));
    expect(gw.serverStatuses[0].error).toMatch(/^ping failed: /);
    expect(gw.connectedServers).toEqual([]);
    expect(gw.listTools()).toEqual([]);
    // The dead client is closed so it cannot leak.
    await vi.waitFor(() => expect(up.closeSpies[0]).toHaveBeenCalled());

    await vi.waitFor(() => expect(gw.serverStatuses[0].connected).toBe(true));
    expect(gw.listTools().map((t) => t.name).sort()).toEqual(['a', 'b']);
    expect(gw.connectedServers).toEqual(['fake']);
    const result = await gw.callTool('a', {});
    expect(result.isError).toBeFalsy();

    // Exactly one reconnect loop ran, and the new client answers its pings.
    await new Promise((r) => setTimeout(r, 120));
    expect(up.transports.length).toBe(2);
    expect(gw.serverStatuses[0].connected).toBe(true);
    expect(up.closeSpies[1]).not.toHaveBeenCalled();
    await gw.close();
  });

  it('close() closes every upstream client and never reconnects', async () => {
    const up = makeUpstream(() => ({ tools: ['a'] }));
    const gw = new Gateway(up.factory);
    const listener = vi.fn();
    await gw.connect(
      [
        { ...fake, pingIntervalMs: 20 },
        { ...fake, name: 'other', prefix: 'other', pingIntervalMs: 20 },
      ],
      FAST,
    );
    expect(gw.connectedServers.sort()).toEqual(['fake', 'other']);
    gw.onToolsChanged(listener);

    await gw.close();

    expect(up.closeSpies[0]).toHaveBeenCalled();
    expect(up.closeSpies[1]).toHaveBeenCalled();
    expect(gw.connectedServers).toEqual([]);
    expect(gw.listTools()).toEqual([]);
    for (const status of gw.serverStatuses) {
      expect(status).toMatchObject({ connected: false, tools: 0 });
    }
    expect(listener).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 100));
    expect(up.transports.length).toBe(2);
    expect(gw.connectedServers).toEqual([]);
  });

  it('close() halts the reconnect loop of an upstream that is still down', async () => {
    const up = makeUpstream(() => ({ tools: null }));
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    await vi.waitFor(() => expect(up.transports.length).toBeGreaterThanOrEqual(2));

    await gw.close();
    // Let an in-flight attempt finish, then the count must stay put.
    await new Promise((r) => setTimeout(r, 50));
    const attempts = up.transports.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(up.transports.length).toBe(attempts);
    expect(gw.connectedServers).toEqual([]);
  });
});

/** Text of the first content block of a tool result. */
function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

interface NamedPlan {
  tools: string[];
  /** Delay before the upstream starts answering, in ms. */
  delayMs?: number;
}

/**
 * In-memory upstreams keyed by server name: every factory call is one connect
 * attempt of that server. Tools answer `<server>:<tool>`.
 */
function makeNamedUpstreams(plan: (serverName: string, attempt: number) => NamedPlan) {
  const servers = new Map<string, McpServer[]>();
  const factory = (config: ServerConfig): Transport => {
    const attempts = servers.get(config.name) ?? [];
    servers.set(config.name, attempts);
    const { tools, delayMs } = plan(config.name, attempts.length + 1);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: config.name, version: '0.0.0' });
    for (const name of tools) {
      server.registerTool(name, { description: `tool ${name}` }, async () => ({
        content: [{ type: 'text' as const, text: `${config.name}:${name}` }],
      }));
    }
    if (delayMs) setTimeout(() => void server.connect(serverSide), delayMs);
    else void server.connect(serverSide);
    attempts.push(server);
    return clientSide;
  };
  return { factory, servers };
}

const first: ServerConfig = { name: 'first', type: 'http', url: 'http://unused-first' };
const second: ServerConfig = { name: 'second', type: 'http', url: 'http://unused-second' };

function statusOf(gw: Gateway, name: string) {
  return gw.serverStatuses.find((s) => s.name === name)!;
}

describe('Gateway tool name collisions', () => {
  const TOOLS: Record<string, string[]> = {
    first: ['shared', 'only_first'],
    second: ['shared', 'only_second'],
  };

  it.each([
    { label: 'the later server connects first', slow: 'first' },
    { label: 'the earlier server connects first', slow: 'second' },
  ])('gives the name to the earlier configured server when $label', async ({ slow }) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const up = makeNamedUpstreams((name) => ({
        tools: TOOLS[name],
        delayMs: name === slow ? 60 : undefined,
      }));
      const gw = new Gateway(up.factory);
      await gw.connect([first, second], FAST);
      gw.stop();

      expect(gw.listTools().map((t) => t.name).sort()).toEqual([
        'only_first',
        'only_second',
        'shared',
      ]);
      expect(textOf(await gw.callTool('shared', {}))).toBe('first:shared');
      expect(gw.catalog.find((t) => t.name === 'shared')?.serverName).toBe('first');

      // `tools` counts registered tools only; the loser lists what it lost.
      expect(statusOf(gw, 'first')).toMatchObject({ connected: true, tools: 2 });
      expect(statusOf(gw, 'first')).not.toHaveProperty('skippedTools');
      expect(statusOf(gw, 'second')).toMatchObject({
        connected: true,
        tools: 1,
        skippedTools: ['shared'],
      });

      const collisions = errorLog.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('tool name collision'));
      expect(collisions).toEqual([
        '[gateway] second — tool name collision, skipped: shared (owned by first)',
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('hands a skipped name to the lower-priority server while its owner is down', async () => {
    // The second attempt of `first` answers slowly so the gap is observable.
    const up = makeNamedUpstreams((name, attempt) => ({
      tools: TOOLS[name],
      delayMs: name === 'first' && attempt > 1 ? 150 : undefined,
    }));
    const gw = new Gateway(up.factory);
    await gw.connect([first, second], FAST);
    expect(statusOf(gw, 'second')).toMatchObject({ tools: 1, skippedTools: ['shared'] });
    const listener = vi.fn();
    gw.onToolsChanged(listener);

    await up.servers.get('first')![0].close();
    await vi.waitFor(() => expect(statusOf(gw, 'first').connected).toBe(false));

    // `second` owns the name now: it is published, routed and counted.
    expect(gw.listTools().map((t) => t.name).sort()).toEqual(['only_second', 'shared']);
    expect(textOf(await gw.callTool('shared', {}))).toBe('second:shared');
    expect(statusOf(gw, 'second')).toMatchObject({ connected: true, tools: 2 });
    expect(statusOf(gw, 'second')).not.toHaveProperty('skippedTools');
    expect(statusOf(gw, 'first')).toMatchObject({ connected: false, tools: 0 });
    expect(statusOf(gw, 'first')).not.toHaveProperty('skippedTools');
    expect(listener).toHaveBeenCalledTimes(1);

    // Once the owner is back it takes the name again (config order wins).
    await vi.waitFor(() => expect(statusOf(gw, 'first').connected).toBe(true));
    gw.stop();
    expect(textOf(await gw.callTool('shared', {}))).toBe('first:shared');
    expect(statusOf(gw, 'first')).toMatchObject({ tools: 2 });
    expect(statusOf(gw, 'second')).toMatchObject({ tools: 1, skippedTools: ['shared'] });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('Gateway upstream tool list pagination', () => {
  /** Low-level upstream whose tools/list answers come from `page`. */
  function makePagedUpstream(page: (cursor: string | undefined) => { tools: string[]; nextCursor?: string }) {
    const cursors: Array<string | undefined> = [];
    const upstream = new Server({ name: 'paged', version: '0.0.0' }, { capabilities: { tools: {} } });
    upstream.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      cursors.push(cursor);
      const { tools, nextCursor } = page(cursor);
      return {
        tools: tools.map(
          (name): Tool => ({ name, description: `tool ${name}`, inputSchema: { type: 'object' } }),
        ),
        nextCursor,
      };
    });
    const factory = (): Transport => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void upstream.connect(serverSide);
      return clientSide;
    };
    return { factory, cursors };
  }

  it('follows nextCursor until the list is exhausted', async () => {
    const up = makePagedUpstream((cursor) => {
      if (cursor === undefined) return { tools: ['a', 'b'], nextCursor: 'page-2' };
      if (cursor === 'page-2') return { tools: ['c'], nextCursor: 'page-3' };
      return { tools: ['d'] };
    });
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    gw.stop();

    expect(up.cursors).toEqual([undefined, 'page-2', 'page-3']);
    expect(gw.listTools().map((t) => t.name).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 4 });
  });

  it('stops when the upstream repeats a cursor', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let calls = 0;
      const up = makePagedUpstream(() => ({ tools: [`t${++calls}`], nextCursor: 'again' }));
      const gw = new Gateway(up.factory);
      await gw.connect([fake], FAST);
      gw.stop();

      // First page, then the page of 'again', which points at itself.
      expect(up.cursors).toEqual([undefined, 'again']);
      expect(gw.listTools().map((t) => t.name).sort()).toEqual(['t1', 't2']);
      expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: 2 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('stops after the page cap when cursors never run out', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let calls = 0;
      const up = makePagedUpstream(() => {
        calls++;
        return { tools: [`t${calls}`], nextCursor: `cursor-${calls}` };
      });
      const gw = new Gateway(up.factory);
      await gw.connect([fake], FAST);
      gw.stop();

      expect(up.cursors).toHaveLength(MAX_TOOL_LIST_PAGES);
      expect(gw.serverStatuses[0]).toMatchObject({ connected: true, tools: MAX_TOOL_LIST_PAGES });
      expect(errorLog.mock.calls.some((args) => String(args[0]).includes('page cap'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Gateway tool call cancellation', () => {
  /** Upstream with one tool that only returns once its request is cancelled. */
  function makeSlowUpstream() {
    let started!: () => void;
    let cancelled!: () => void;
    const state = {
      started: new Promise<void>((resolve) => {
        started = resolve;
      }),
      cancelled: new Promise<void>((resolve) => {
        cancelled = resolve;
      }),
      factory: (): Transport => {
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
    };
    return state;
  }

  it('forwards the abort signal to the upstream call and rejects instead of answering', async () => {
    const up = makeSlowUpstream();
    const gw = new Gateway(up.factory);
    await gw.connect([fake], FAST);
    gw.stop();

    const controller = new AbortController();
    const call = gw.callTool('slow', {}, { signal: controller.signal });
    const outcome = call.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await up.started;
    controller.abort(new Error('client went away'));

    // The upstream handler observes the cancellation...
    await up.cancelled;
    // ...and the caller gets a rejection, not a "Tool error" result.
    const settled = await outcome;
    expect(settled).not.toHaveProperty('result');
    expect(String((settled as { error: Error }).error.message)).toContain('client went away');
  });

  it('keeps the Tool error result for real failures, also when a signal is given', async () => {
    const up = makeSlowUpstream();
    const gw = new Gateway(up.factory);
    await gw.connect([{ ...fake, timeoutMs: 30 }], FAST);
    gw.stop();

    const controller = new AbortController();
    const result = await gw.callTool('slow', {}, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Tool error: /);
  });
});
