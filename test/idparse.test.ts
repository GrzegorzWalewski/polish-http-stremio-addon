import { describe, expect, it } from 'vitest';
import { parseStreamId, StreamIdError } from '../src/stremio.js';

describe('parseStreamId', () => {
  it('parses a movie id', () => {
    expect(parseStreamId('movie', 'tt0083564.json')).toEqual({
      type: 'movie',
      imdbId: 'tt0083564',
    });
  });

  it('parses a series id with season/episode', () => {
    expect(parseStreamId('series', 'tt0903747:2:1.json')).toEqual({
      type: 'series',
      imdbId: 'tt0903747',
      season: 2,
      episode: 1,
    });
  });

  it('parses series ids without the .json suffix', () => {
    expect(parseStreamId('series', 'tt5180501:1:5').imdbId).toBe('tt5180501');
  });

  it('parses percent-encoded series ids (Stremio encodes the colons)', () => {
    expect(parseStreamId('series', 'tt14129378%3A1%3A1.json')).toEqual({
      type: 'series',
      imdbId: 'tt14129378',
      season: 1,
      episode: 1,
    });
  });

  it('rejects ids with malformed percent-escapes', () => {
    expect(() => parseStreamId('series', 'tt123%ZZ:1:1')).toThrow(StreamIdError);
  });

  it('rejects series ids missing season/episode', () => {
    expect(() => parseStreamId('series', 'tt0903747.json')).toThrow(StreamIdError);
    expect(() => parseStreamId('series', 'tt0903747:2.json')).toThrow(StreamIdError);
  });

  it('rejects malformed ids', () => {
    expect(() => parseStreamId('movie', 'nm0000000.json')).toThrow(StreamIdError);
    expect(() => parseStreamId('movie', 'foobar.json')).toThrow(StreamIdError);
    expect(() => parseStreamId('series', 'tt123:x:1')).toThrow(StreamIdError);
    expect(() => parseStreamId('series', 'tt123:1:-1')).toThrow(StreamIdError);
  });

  it('rejects unknown resource kinds', () => {
    expect(() => parseStreamId('catalog', 'tt0083564.json')).toThrow(StreamIdError);
  });
});
