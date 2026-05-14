import { readFileSync } from 'fs';
import { z } from 'zod';

const ServerConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['stdio', 'http', 'sse', 'direct']).default('stdio'),
  // stdio fields
  container: z.string().optional(),
  cmd: z.array(z.string()).optional(),
  // http fields
  url: z.string().optional(),
  // naming / docs
  prefix: z.string().optional(),
  rename: z.record(z.string(), z.string()).optional(),
  descriptionPrefix: z.string().optional(),
  // common
  enabled: z.boolean().default(true),
  timeoutMs: z.number().optional(),
});

const GatewayConfigSchema = z.object({
  servers: z.array(ServerConfigSchema),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadConfig(path = 'servers.json'): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return GatewayConfigSchema.parse(raw);
}
