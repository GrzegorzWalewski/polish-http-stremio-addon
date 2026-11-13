import type { StreamResult } from 'movies-series-fetcher/lib';

export const ADDON_ID = 'community.polish-streams-addon';
export const ADDON_VERSION = '1.0.0';

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: { name: string; types: string[]; idPrefixes: string[] }[];
  types: string[];
  catalogs: unknown[];
  idPrefixes: string[];
}

export const MANIFEST: Manifest = {
  id: ADDON_ID,
  version: ADDON_VERSION,
  name: 'Polish Streams',
  description:
    'Stream links from 17 Polish streaming sites (movies-series-fetcher). Direct URLs where a resolver can produce them, otherwise a link that opens the page in a browser.',
  resources: [
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
  ],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
};

/** Raised for malformed Stremio ids — the server maps it to HTTP 400. */
export class StreamIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamIdError';
  }
}

export type StremioType = 'movie' | 'series';

export interface ParsedStreamId {
  type: StremioType;
  imdbId: string;
  season?: number;
  episode?: number;
}

/**
 * Strict id parsing: `/stream/movie/tt0083564.json`,
 * `/stream/series/tt0903747:2:1.json`. Series without both season and
 * episode is rejected (Stremio always sends them).
 */
export function parseStreamId(kind: string, raw: string): ParsedStreamId {
  const rest = raw.replace(/\.json$/i, '');

  if (kind === 'movie') {
    const m = /^(tt\d+)$/.exec(rest);
    if (!m) {
      throw new StreamIdError(
        `Malformed movie id "${raw}" — expected tt followed by digits (e.g. tt0083564)`
      );
    }
    return { type: 'movie', imdbId: m[1] };
  }

  if (kind === 'series') {
    const m = /^(tt\d+):(\d+):(\d+)$/.exec(rest);
    if (!m) {
      throw new StreamIdError(
        `Malformed series id "${raw}" — expected tt:id:season:episode with all parts numeric (e.g. tt0903747:1:1)`
      );
    }
    return {
      type: 'series',
      imdbId: m[1],
      season: Number(m[2]),
      episode: Number(m[3]),
    };
  }

  throw new StreamIdError(`Unsupported resource type "${kind}"`);
}

export interface StremioStream {
  name: string;
  title: string;
  url?: string;
  externalUrl?: string;
  headers?: Record<string, string>;
  /** official per-stream headers channel (desktop + android honor this;
   * the top-level `headers` field is not part of the protocol) */
  behaviorHints?: {
    proxyHeaders?: Record<string, string>;
    notWebReady?: boolean;
  };
}

/** `.m3u8`/`.mpd`/`.mp4`/… URLs Stremio can play natively. */
export function isDirectUrl(url: string): boolean {
  return /\.(m3u8|mpd|mp4|mkv|avi|webm)(\?|#|$)/i.test(url);
}

function streamTitle(r: StreamResult): string {
  const parts = [r.provider, r.quality, r.language].filter(Boolean) as string[];
  const base = parts.join(' — ');
  return r.label ? `${base} [${r.label}]` : base;
}

/**
 * Map provider StreamResults to Stremio streams: direct URLs → `{url}`,
 * everything else → `{externalUrl}` (Stremio opens it in the browser).
 * Playable streams are listed first; dedupes by URL, caps output so the
 * manifest response stays sane.
 */
export function toStremioStreams(results: StreamResult[]): StremioStream[] {
  const seen = new Set<string>();
  const playable: StremioStream[] = [];
  const external: StremioStream[] = [];

  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);

    const title = streamTitle(r);
    // resolvers may return extension-less media (signed token URLs) — they
    // attach playback headers exactly when they verified the target is media
    if (isDirectUrl(r.url) || (r.headers && Object.keys(r.headers).length > 0)) {
      const s: StremioStream = { name: r.provider, title, url: r.url };
      const hdrs = r.headers && Object.keys(r.headers).length > 0 ? r.headers : undefined;
      if (hdrs) {
        s.headers = hdrs;
        s.behaviorHints = { proxyHeaders: hdrs, notWebReady: true };
      }
      playable.push(s);
    } else {
      external.push({
        name: r.provider,
        title: `${title} (open in browser)`,
        externalUrl: r.url,
      });
    }
    if (playable.length + external.length >= 30) break;
  }
  return [...playable, ...external];
}

export function streamResponse(streams: StremioStream[]): { streams: StremioStream[] } {
  return { streams };
}
