import { describe, expect, it } from 'vitest';
import { isDirectUrl, toStremioStreams } from '../src/stremio.js';
import type { StreamResult } from 'movies-series-fetcher/lib';

describe('isDirectUrl', () => {
  it('recognizes playable media URLs', () => {
    expect(isDirectUrl('https://cdn.example/video.m3u8')).toBe(true);
    expect(isDirectUrl('https://cdn.example/video.mp4?token=x')).toBe(true);
    expect(isDirectUrl('https://cdn.example/video.MPD')).toBe(true);
    expect(isDirectUrl('https://x.y/f.mkv#t=10')).toBe(true);
  });

  it('rejects embed/page URLs', () => {
    expect(isDirectUrl('https://ebd.cda.pl/620x368/abc123')).toBe(false);
    expect(isDirectUrl('https://site.pl/film/seksmisja')).toBe(false);
    expect(isDirectUrl('https://voe.sx/e/abc123')).toBe(false);
  });
});

describe('toStremioStreams', () => {
  const result = (over: Partial<StreamResult>): StreamResult => ({
    provider: 'cda.pl',
    quality: '1080p',
    language: 'Lektor PL',
    url: 'https://example.com/v',
    label: null,
    ...over,
  });

  it('maps direct URLs to {url}', () => {
    const streams = toStremioStreams([
      result({ url: 'https://cdn.example/v.m3u8' }),
    ]);
    expect(streams).toHaveLength(1);
    // playable rows route through the local proxy
    expect(streams[0].url).toContain('/proxy?u=');
    expect(streams[0].url).toContain(encodeURIComponent('https://cdn.example/v.m3u8'));
    expect(streams[0].externalUrl).toBeUndefined();
    expect(streams[0].title).toBe('cda.pl — 1080p — Lektor PL');
  });

  it('maps embed/page URLs to {externalUrl}', () => {
    const streams = toStremioStreams([
      result({ url: 'https://site.pl/film/x' }),
    ]);
    expect(streams[0].externalUrl).toBe('https://site.pl/film/x');
    expect(streams[0].url).toBeUndefined();
    expect(streams[0].title).toContain('(open in browser)');
  });

  it('appends [label] when present', () => {
    const streams = toStremioStreams([
      result({ label: 'Cda (Lektor PL)', url: 'https://cdn.example/a.mp4' }),
    ]);
    expect(streams[0].title).toBe('cda.pl — 1080p — Lektor PL [Cda (Lektor PL)]');
  });

  it('omits missing quality/language', () => {
    const streams = toStremioStreams([
      result({ quality: null, language: null, url: 'https://cdn.example/v.mp4' }),
    ]);
    expect(streams[0].title).toBe('cda.pl');
  });

  it('dedupes by url', () => {
    const streams = toStremioStreams([
      result({ url: 'https://same.example/v.mp4' }),
      result({ url: 'https://same.example/v.mp4', provider: 'other' }),
    ]);
    expect(streams).toHaveLength(1);
  });

  it('caps output at 30 (total) and 4 per provider', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      result({ url: `https://x.example/${i}.mp4` })
    );
    expect(toStremioStreams(many)).toHaveLength(4);

    const spread = Array.from({ length: 50 }, (_, i) =>
      result({ url: `https://x.example/${i}.mp4`, provider: `prov${i}.example` })
    );
    expect(toStremioStreams(spread)).toHaveLength(30);
  });
});
