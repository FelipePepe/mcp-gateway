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
});

const GatewayConfigSchema = z.object({
  servers: z.array(ServerConfigSchema),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function parseConfig(raw: unknown): GatewayConfig {
  return GatewayConfigSchema.parse(raw);
}

export function loadConfig(path = 'servers.json'): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return parseConfig(raw);
}
