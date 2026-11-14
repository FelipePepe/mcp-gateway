import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('accepts local stdio servers without a container', () => {
    const config = parseConfig({
      servers: [
        {
          name: 'engram',
          type: 'stdio',
          cmd: ['/usr/local/bin/engram', 'mcp'],
        },
      ],
    });

    expect(config.servers[0]).toMatchObject({
      name: 'engram',
      type: 'stdio',
      cmd: ['/usr/local/bin/engram', 'mcp'],
      enabled: true,
    });
  });

  it('rejects http servers without a url', () => {
    expect(() =>
      parseConfig({
        servers: [{ name: 'search', type: 'http' }],
      }),
    ).toThrow(/url/);
  });

  it('rejects stdio servers without a command', () => {
    expect(() =>
      parseConfig({
        servers: [{ name: 'broken', type: 'stdio' }],
      }),
    ).toThrow(/cmd/);
  });

  it('accepts a positive pingIntervalMs and leaves it unset by default', () => {
    const config = parseConfig({
      servers: [
        { name: 'search', type: 'http', url: 'http://search:8080/mcp', pingIntervalMs: 5000 },
        { name: 'plain', type: 'http', url: 'http://plain:8080/mcp' },
      ],
    });

    expect(config.servers[0].pingIntervalMs).toBe(5000);
    expect(config.servers[1].pingIntervalMs).toBeUndefined();
  });

  it.each([0, -1, 1.5])('rejects pingIntervalMs %s', (pingIntervalMs) => {
    expect(() =>
      parseConfig({
        servers: [{ name: 'search', type: 'http', url: 'http://search:8080/mcp', pingIntervalMs }],
      }),
    ).toThrow(/pingIntervalMs/);
  });
});
