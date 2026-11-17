import type { StreamResult } from 'movies-series-fetcher/lib';
import { proxyUrlFor } from './proxy.js';

export const ADDON_ID = 'community.polish-streams-addon';
export const ADDON_VERSION = '1.0.15';

/**
 * Base URL of this addon's own server (used for stream proxying).
 * Set ADDON_PUBLIC_URL when the addon is reached from other devices
 * (e.g. https://polhttp.example.com) — proxied stream URLs are absolute,
 * so `localhost` would break remote clients.
 */
export function addonBaseUrl(): string {
  const pub = process.env.ADDON_PUBLIC_URL?.trim();
  if (pub) return pub.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT ?? 7777}`;
}

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
 * episode is rejected (Stremio always sends them). The id segment may be
 * percent-encoded (Stremio encodes the colons: `tt123%3A1%3A1`) — it is
 * decoded before matching; malformed escapes fall back to the raw value.
 */
export function parseStreamId(kind: string, raw: string): ParsedStreamId {
  let rest = raw.replace(/\.json$/i, '');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep raw */
  }

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

/** Media context used to render the stream description (right side). */
export interface StreamMeta {
  /** movie / series title (Polish) */
  name: string;
  season?: number;
  episode?: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Polish-language conventions on the sites → audio/subtitle metadata.
 * Only a single `language` tag exists per row, so this is best-effort:
 *  - "Lektor PL" = Polish voice-over track (no subtitles)
 *  - "Napisy PL" = original audio + Polish subtitles
 *  - "Dubbing"   = Polish dub track
 *  - "Polski"    = Polish audio
 *  - anything else / empty = no known metadata
 */
export function audioSubsFromLanguage(language: string | null): { audio: string; subs: string } {
  const l = (language ?? '').toLowerCase();
  if (l.includes('napisy')) return { audio: 'Original', subs: 'Polish' };
  if (l.includes('lektor')) return { audio: 'Lektor PL', subs: 'None' };
  if (l.includes('dubb')) return { audio: 'Dubbing PL', subs: 'None' };
  if (l.includes('polski') || l.includes('polish')) return { audio: 'Polish', subs: 'None' };
  if (l) return { audio: 'Original', subs: 'None' };
  // no language tag: the sources are Polish streaming sites, so Polish is
  // the overwhelmingly likely default
  return { audio: 'Polish', subs: 'None' };
}

/** Rows kept per provider — some emit dozens of near-identical variants. */
const MAX_PER_PROVIDER = 4;
const MAX_TOTAL = 30;

/**
 * Map provider StreamResults to Stremio streams: direct URLs → `{url}`,
 * everything else → `{externalUrl}` (Stremio opens it in the browser).
 * Playable streams are listed first; dedupes by URL; caps rows per provider
 * and in total. Streams that need extra headers (Referer-gated MP4s) are
 * rewritten to the addon's local /proxy so the player needs no headers.
 */
export function toStremioStreams(results: StreamResult[], meta?: StreamMeta): StremioStream[] {
  const seen = new Set<string>();
  const perProvider = new Map<string, number>();
  const playable: StremioStream[] = [];
  const external: StremioStream[] = [];

  // left (bold) label: addon brand / quality / source site
  const leftLabel = (r: StreamResult): string =>
    `PolHTTP\n${r.quality ?? '—'}\n${r.provider}`;

  // right (description) label: title (SxxExx) / quality - language /
  // source / audio / subtitles
  const rightLabel = (r: StreamResult): string => {
    const se =
      meta && meta.season && meta.episode
        ? ` (S${pad2(meta.season)}E${pad2(meta.episode)})`
        : '';
    const qLang =
      [r.quality, r.language].filter(Boolean).join(' - ') || '—';
    const { audio, subs } = audioSubsFromLanguage(r.language);
    return [
      meta ? `${meta.name}${se}` : null,
      qLang,
      `Source: ${r.provider}`,
      `Audio: ${audio}`,
      `Subtitles: ${subs}`,
    ]
      .filter(Boolean)
      .join('\n');
  };

  for (const r of results) {
    if (seen.has(r.url)) continue;
    if ((perProvider.get(r.provider) ?? 0) >= MAX_PER_PROVIDER) continue;
    if (playable.length + external.length >= MAX_TOTAL) break;
    seen.add(r.url);
    perProvider.set(r.provider, (perProvider.get(r.provider) ?? 0) + 1);

    const hdrs = r.headers && Object.keys(r.headers).length > 0 ? r.headers : undefined;
    // resolvers may return extension-less media (signed token URLs) — they
    // attach playback headers exactly when they verified the target is media
    if (isDirectUrl(r.url) || hdrs) {
      // every playable row routes through the local proxy: header-gated
      // media works without player support, and the resolver stage can
      // pre-warm the first bytes for instant playback start
      const s: StremioStream = {
        name: leftLabel(r),
        title: rightLabel(r),
        url: proxyUrlFor(addonBaseUrl(), r.url, hdrs),
      };
      playable.push(s);
    } else {
      external.push({
        name: leftLabel(r),
        title: `${rightLabel(r)}\n(open in browser)`,
        externalUrl: r.url,
      });
    }
  }
  return [...playable, ...external];
}

export function streamResponse(streams: StremioStream[]): { streams: StremioStream[] } {
  return { streams };
}
