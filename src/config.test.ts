import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodError } from 'zod';
import { parseConfig } from './config.js';

/** Zod issues raised by `parse`; fails the test when it does not throw. */
function issuesOf(parse: () => unknown): ZodError['issues'] {
  try {
    parse();
  } catch (error) {
    return (error as ZodError).issues;
  }
  throw new Error('expected the config to be rejected');
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('rejects duplicate server names, pointing at the repeated entry', () => {
    const parse = () =>
      parseConfig({
        servers: [
          { name: 'search', type: 'http', url: 'http://search:8080/mcp' },
          { name: 'other', type: 'http', url: 'http://other:8080/mcp' },
          { name: 'search', type: 'stdio', cmd: ['search-mcp'], enabled: false },
        ],
      });

    // ZodError.message is the JSON of its issues, so quotes come escaped.
    expect(parse).toThrow(/duplicate server name/);
    const issues = issuesOf(parse);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['servers', 2, 'name']);
    expect(issues[0].message).toBe('duplicate server name "search" (already used by servers[0])');
  });

  it.each(['http', 'sse', 'direct'])('rejects container on a %s server', (type) => {
    const parse = () =>
      parseConfig({
        servers: [
          {
            name: 'misplaced',
            type,
            url: 'http://misplaced:8080/mcp',
            cmd: ['misplaced-mcp'],
            container: 'misplaced-container',
          },
        ],
      });

    expect(parse).toThrow(/container is only valid for stdio servers/);
    const issues = issuesOf(parse);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['servers', 0, 'container']);
  });

  it('warns once per prefix shared by enabled servers, and still parses', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const config = parseConfig({
      servers: [
        { name: 'one', type: 'http', url: 'http://one:8080/mcp', prefix: 'web' },
        { name: 'two', type: 'http', url: 'http://two:8080/mcp', prefix: 'web' },
        { name: 'three', type: 'stdio', cmd: ['three-mcp'], prefix: 'web' },
        { name: 'lonely', type: 'stdio', cmd: ['lonely-mcp'], prefix: 'solo' },
        { name: 'plain', type: 'stdio', cmd: ['plain-mcp'] },
      ],
    });

    expect(config.servers).toHaveLength(5);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = String(errorLog.mock.calls[0][0]);
    expect(line).toMatch(/^\[gateway\] /);
    expect(line).toContain('"web"');
    expect(line).toContain('one, two, three');
  });

  it('does not warn about a prefix repeated only by a disabled server', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    parseConfig({
      servers: [
        { name: 'one', type: 'http', url: 'http://one:8080/mcp', prefix: 'web' },
        { name: 'two', type: 'http', url: 'http://two:8080/mcp', prefix: 'web', enabled: false },
      ],
    });

    expect(errorLog).not.toHaveBeenCalled();
  });

  it('still parses the deployed config shape without warnings', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const config = parseConfig({
      servers: [
        {
          name: 'search',
          type: 'http',
          url: 'http://search:8080/mcp',
          prefix: 'search',
          timeoutMs: 60000,
          connectTimeoutMs: 5000,
          pingIntervalMs: 15000,
        },
        {
          name: 'notes',
          type: 'stdio',
          container: 'notes-mcp',
          cmd: ['node', '/app/dist/index.js'],
          prefix: 'notes',
          timeoutMs: 120000,
        },
        { name: 'memory', type: 'stdio', cmd: ['/usr/local/bin/memory', 'mcp'], prefix: 'memory' },
        // `type` defaults to stdio, so a bare container + cmd entry is valid.
        { name: 'legacy', container: 'legacy-mcp', cmd: ['legacy-mcp'] },
        {
          name: 'parked',
          type: 'stdio',
          container: 'parked-mcp',
          cmd: ['parked-mcp'],
          prefix: 'parked',
          enabled: false,
        },
      ],
    });

    expect(config.servers.map((server) => [server.name, server.type, server.enabled])).toEqual([
      ['search', 'http', true],
      ['notes', 'stdio', true],
      ['memory', 'stdio', true],
      ['legacy', 'stdio', true],
      ['parked', 'stdio', false],
    ]);
    expect(config.servers[1]).toMatchObject({ container: 'notes-mcp', timeoutMs: 120000 });
    expect(config.servers[0]).toMatchObject({ connectTimeoutMs: 5000, pingIntervalMs: 15000 });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
