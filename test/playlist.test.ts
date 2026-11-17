import { describe, expect, it } from 'vitest';
import { rewritePlaylist } from '../src/proxy.js';

const upstream = new URL('https://vwaw039.cda.pl/tok/16na/aaa/26058628raw/master.m3u8');
const base = 'https://polhttp.example.com';
const h = 'headerblob';

/** Re-extract the upstream URL from a rewritten proxy URL. */
const proxied = (line: string): string | null => {
  const m = /u=([^&\s"]+)/.exec(line);
  return m ? decodeURIComponent(m[1]) : null;
};

describe('rewritePlaylist', () => {
  it('rewrites bare segment lines to proxy URLs with the header blob', () => {
    const out = rewritePlaylist(
      '#EXTM3U\nseg_1.ts\nhttps://cdn.x/abs/seg_2.ts\n',
      upstream,
      base,
      h
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(proxied(lines[1])).toBe('https://vwaw039.cda.pl/tok/16na/aaa/26058628raw/seg_1.ts');
    expect(proxied(lines[2])).toBe('https://cdn.x/abs/seg_2.ts');
    expect(lines[1]).toContain(`h=${h}`);
  });

  it('rewrites URIs inside tag attributes (#EXT-X-MAP init segment)', () => {
    const out = rewritePlaylist(
      '#EXT-X-MAP:URI="video_1_1080p.mp4",BYTERANGE="899@0"\n',
      upstream,
      base,
      h
    );
    expect(out).toContain('BYTERANGE="899@0"');
    expect(proxied(out)).toBe(
      'https://vwaw039.cda.pl/tok/16na/aaa/26058628raw/video_1_1080p.mp4'
    );
  });

  it('rewrites demuxed audio rendition URIs (#EXT-X-MEDIA)', () => {
    const out = rewritePlaylist(
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_0.m3u8",GROUP-ID="a",LANGUAGE="pl"\n',
      upstream,
      base,
      h
    );
    expect(out).toContain('TYPE=AUDIO');
    expect(proxied(out)).toBe('https://vwaw039.cda.pl/tok/16na/aaa/26058628raw/stream_0.m3u8');
  });

  it('leaves tag lines without URI attributes untouched', () => {
    const line = '#EXT-X-STREAM-INF:BANDWIDTH=4277207,RESOLUTION=1920x1080';
    expect(rewritePlaylist(`${line}\n`, upstream, base, h).trim()).toBe(line);
  });

  it('rewrites absolute URIs inside tag attributes and keeps headers', () => {
    const out = rewritePlaylist(
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.x/k",IV=0x1\n',
      upstream,
      base,
      h
    );
    expect(proxied(out)).toBe('https://keys.x/k');
    expect(out).toContain(`h=${h}`);
    expect(out).toContain('IV=0x1');
  });
});
