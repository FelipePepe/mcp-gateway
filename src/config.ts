import { readFileSync } from 'fs';
import { z } from 'zod';

const ServerConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['stdio', 'http', 'sse', 'direct']).default('stdio'),
  container: z.string().min(1).optional(),
  cmd: z.array(z.string().min(1)).min(1).optional(),
  url: z.string().url().optional(),
  prefix: z.string().min(1).optional(),
  rename: z.record(z.string(), z.string().min(1)).optional(),
  descriptionPrefix: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  /** Liveness ping interval; the gateway defaults to 30000 when absent. */
  pingIntervalMs: z.number().int().positive().optional(),
}).superRefine((server, ctx) => {
  if ((server.type === 'http' || server.type === 'sse') && !server.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: `${server.type} servers require a url`,
    });
  }

  if ((server.type === 'stdio' || server.type === 'direct') && !server.cmd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cmd'],
      message: `${server.type} servers require a cmd`,
    });
  }

  // Only stdio servers are run through `docker exec` in a container; on any
  // other type the field would be silently ignored.
  if (server.type !== 'stdio' && server.container !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['container'],
      message: `container is only valid for stdio servers (type is ${server.type})`,
    });
  }
});

const GatewayConfigSchema = z.object({
  servers: z.array(ServerConfigSchema),
}).superRefine((config, ctx) => {
  // The name identifies a server in routing, status and logs: it must be
  // unique even across disabled servers.
  const firstIndex = new Map<string, number>();
  config.servers.forEach((server, index) => {
    const first = firstIndex.get(server.name);
    if (first === undefined) {
      firstIndex.set(server.name, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['servers', index, 'name'],
      message: `duplicate server name "${server.name}" (already used by servers[${first}])`,
    });
  });
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Enabled servers may share a prefix on purpose, but their tool names can
 * then collide (the gateway keeps the first configured one): warn once per
 * shared prefix.
 */
function warnDuplicatePrefixes(config: GatewayConfig): void {
  const byPrefix = new Map<string, string[]>();
  for (const server of config.servers) {
    if (!server.enabled || server.prefix === undefined) continue;
    const names = byPrefix.get(server.prefix) ?? [];
    names.push(server.name);
    byPrefix.set(server.prefix, names);
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length < 2) continue;
    console.error(
      `[gateway] prefix "${prefix}" is shared by servers ${names.join(', ')}; their tool names may collide`,
    );
  }
}

export function parseConfig(raw: unknown): GatewayConfig {
  const config = GatewayConfigSchema.parse(raw);
  warnDuplicatePrefixes(config);
  return config;
}

export function loadConfig(path = 'servers.json'): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return parseConfig(raw);
}
