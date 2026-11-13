import { describe, expect, it } from 'vitest';
import { MANIFEST, ADDON_ID, ADDON_VERSION } from '../src/stremio.js';

describe('MANIFEST', () => {
  it('exposes the stream resource for movie+series with tt prefix', () => {
    expect(MANIFEST.id).toBe(ADDON_ID);
    expect(MANIFEST.version).toBe(ADDON_VERSION);
    expect(MANIFEST.resources).toEqual([
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
    ]);
    expect(MANIFEST.types).toEqual(['movie', 'series']);
    expect(MANIFEST.catalogs).toEqual([]);
    expect(MANIFEST.idPrefixes).toEqual(['tt']);
  });

  it('has name and description strings', () => {
    expect(typeof MANIFEST.name).toBe('string');
    expect(MANIFEST.name.length).toBeGreaterThan(0);
    expect(typeof MANIFEST.description).toBe('string');
  });
});
