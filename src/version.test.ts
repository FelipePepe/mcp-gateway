import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { readVersion, VERSION } from './version.js';

describe('gateway version', () => {
  it('is the version of package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).toBe(pkg.version);
  });

  it('falls back to 0.0.0 when package.json cannot be read or has no version', () => {
    expect(readVersion(new URL('./does-not-exist/package.json', import.meta.url))).toBe('0.0.0');
    // A JSON file without a "version" field.
    expect(readVersion(new URL('../tsconfig.json', import.meta.url))).toBe('0.0.0');
  });
});
