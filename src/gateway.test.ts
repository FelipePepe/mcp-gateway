import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry, Gateway, type RetryOptions } from './gateway.js';

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
