import { readFileSync } from 'fs';

const FALLBACK_VERSION = '0.0.0';

/** Read `version` from a package.json; '0.0.0' when it cannot be read. */
export function readVersion(packageJsonUrl: URL): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonUrl, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Version of the gateway, read once from package.json. The file sits one
 * level above this module both in the sources (`src/version.ts`) and in the
 * image (`/app/dist/version.js` next to `/app/package.json`).
 */
export const VERSION = readVersion(new URL('../package.json', import.meta.url));
