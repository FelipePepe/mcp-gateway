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
});
