import {
  providers,
  safeProviderSearch,
  resolveMediaDetailsFromImdb,
  resolveAbsoluteEpisode,
  resolveEmbed,
  classifyStreamUrl,
  TmdbAuthError,
  type MediaResult,
  type StreamResult,
} from 'movies-series-fetcher/lib';
import { TtlCache, SingleFlight } from './cache.js';
import { warmUp } from './proxy.js';
import {
  StreamIdError,
  type ParsedStreamId,
  type StremioStream,
  type StreamMeta,
  toStremioStreams,
} from './stremio.js';

/**
 * Ceiling per provider. On the server CPU a cold FlareSolverr solve takes
 * 75-80s — it NEVER fits in-request there, but the solve keeps running in
 * the background and its cookies are cached for the next request, so a
 * smaller ceiling only bounds worst-case latency (60s ceiling = every
 * request behind a slow provider stalled a full minute).
 */
const PROVIDER_TIMEOUT_MS = 40_000;
/** Embed resolvers: the byse PoW solve is ~0.7s on a fast CPU but 3-5s on
 * the weak server under concurrent load — a 5s ceiling made warm-cookie
 * byse embeds flaky MISSes (rows degraded to external). */
const EMBED_TIMEOUT_MS = 10_000;
const RESOLVE_STAGE_BUDGET_MS = 16_000;
const ABSOLUTE_EPISODE_TTL_MS = 6 * 60 * 60 * 1000;
const SUCCESS_TTL_MS = 30 * 60 * 1000;
const ALL_WARNED_TTL_MS = 5 * 60 * 1000;

export class UpstreamNotFoundError extends Error {
  constructor(imdbId: string) {
    super(`No TMDB entry found for ${imdbId}`);
    this.name = 'UpstreamNotFoundError';
  }
}

export interface StreamOutcome {
  streams: StremioStream[];
  warnings: string[];
}

const streamCache = new TtlCache<StreamOutcome>();
const flight = new SingleFlight();

/** Recent provider warnings — surfaced by /healthz for debugging. */
export const lastWarnings: { at: number; text: string }[] = [];

function recordWarnings(warnings: string[]): void {
  for (const w of warnings) {
    lastWarnings.unshift({ at: Date.now(), text: w });
  }
  lastWarnings.length = Math.min(lastWarnings.length, 50);
}

/** Number of cached stream outcomes (for /healthz). */
export function streamCacheSize(): number {
  return streamCache.size;
}

/** Absolute episode lookup cached per tmdbId:season:episode for 6h. */
const absEpCache = new TtlCache<number>();

async function absoluteEpisodeFor(
  media: MediaResult,
  season: number,
  episode: number
): Promise<number | undefined> {
  if (season === 1) return episode; // sum of prior seasons is 0
  const key = `${media.tmdbId}:${season}:${episode}`;
  const cached = absEpCache.get(key);
  if (cached !== undefined) return cached;
  const abs = (await resolveAbsoluteEpisode(media.tmdbId, season, episode)) ?? undefined;
  if (abs !== undefined) absEpCache.set(key, abs, ABSOLUTE_EPISODE_TTL_MS);
  return abs;
}

async function runProviders(
  media: MediaResult,
  parsed: ParsedStreamId
): Promise<{ results: StreamResult[]; warnings: string[] }> {
  console.log(
    `${new Date().toISOString()} media: ${media.imdbId} "${media.plTitle}" / "${media.originalTitle}" ${media.year} ${media.type}`
  );
  const absoluteEpisode =
    parsed.season && parsed.episode
      ? await absoluteEpisodeFor(media, parsed.season, parsed.episode)
      : undefined;

  const attempts = await Promise.all(
    providers.map(async (prov) => {
      const t0 = performance.now();
      const a = await safeProviderSearch(
        prov.name,
        () =>
          prov.search({
            imdbId: media.imdbId,
            type: media.type,
            title: media.plTitle,
            originalTitle: media.originalTitle,
            year: media.year,
            runtimeMinutes: media.runtimeMinutes,
            season: parsed.season,
            episode: parsed.episode,
            absoluteEpisode,
          }),
        PROVIDER_TIMEOUT_MS
      );
      console.log(
        `${new Date().toISOString()} provider ${prov.name} -> ${a.results.length} rows ${Math.round(performance.now() - t0)}ms${a.warning ? ` (warn: ${a.warning.slice(0, 80)})` : ''}`
      );
      return a;
    })
  );

  const warnings = attempts.map((a) => a.warning).filter((w): w is string => !!w);
  recordWarnings(warnings);
  return { results: attempts.flatMap((a) => a.results), warnings };
}

/**
 * Resolver stage: known hoster embeds → direct media URLs (concurrently,
 * 15s each, hard stage budget 20s). Unresolved embeds and site pages keep
 * their original URL (the addon maps them to external links).
 */
async function resolveStage(results: StreamResult[]): Promise<StreamResult[]> {
  const t0 = performance.now();
  const host = (u: string): string => new URL(u).host;
  let resolvedCount = 0;

  const tasks = results.map(async (r): Promise<StreamResult> => {
    if (classifyStreamUrl(r.url) !== 'embed') {
      // already-direct progressive media also gets pre-warmed (with its
      // headers — cda/freedisc CDNs reject header-less prefetches)
      warmUp(r.url, r.headers);
      return r;
    }
    const rt0 = performance.now();
    const resolved = await resolveEmbed(r.url, EMBED_TIMEOUT_MS);
    const ms = Math.round(performance.now() - rt0);
    if (!resolved) {
      console.log(
        `${new Date().toISOString()} resolve MISS ${host(r.url)} ${ms}ms (external link)`
      );
      return r;
    }
    resolvedCount++;
    console.log(
      `${new Date().toISOString()} resolve OK   ${host(r.url)} ${ms}ms -> ${host(resolved.url)}`
    );
    // pre-fetch the first bytes now so the player starts on a warm cache
    warmUp(resolved.url, resolved.headers);
    return {
      ...r,
      url: resolved.url,
      quality: resolved.quality ?? r.quality,
      label: `resolved (${r.label ?? r.provider})`,
      headers: resolved.headers,
    };
  });

  // resolveEmbed already enforces the per-embed timeout; the race guard
  // only protects against a stuck resolveEmbed implementation
  const out = await Promise.race([
    Promise.all(tasks),
    new Promise<StreamResult[]>((resolve) =>
      setTimeout(() => resolve(results), RESOLVE_STAGE_BUDGET_MS)
    ),
  ]);
  const embeds = results.filter((r) => classifyStreamUrl(r.url) === 'embed').length;
  console.log(
    `${new Date().toISOString()} resolve stage: ${resolvedCount}/${embeds} embeds resolved in ${Math.round(performance.now() - t0)}ms`
  );
  return out;
}

/**
 * Full pipeline: parse → cache → TMDB (imdb) → absolute episode →
 * provider sweep → classify → map. Never rethrows provider errors —
 * they become warnings; only auth/id errors propagate as HTTP errors.
 */
export async function getStreams(parsed: ParsedStreamId): Promise<StreamOutcome> {
  const cacheKey = `${parsed.type}:${parsed.imdbId}:${parsed.season ?? ''}:${parsed.episode ?? ''}`;

  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  const outcome = await flight.run(cacheKey, async (): Promise<StreamOutcome> => {
    const media = await resolveMediaDetailsFromImdb(parsed.imdbId, parsed.type === 'movie' ? 'movie' : 'tv');
    if (!media) throw new UpstreamNotFoundError(parsed.imdbId);

    const { results, warnings } = await runProviders(media, parsed);
    const resolved = await resolveStage(results);
    const meta: StreamMeta = {
      name: media.plTitle,
      season: parsed.season,
      episode: parsed.episode,
    };
    const outcome: StreamOutcome = { streams: toStremioStreams(resolved, meta), warnings };

    streamCache.set(cacheKey, outcome, results.length > 0 ? SUCCESS_TTL_MS : ALL_WARNED_TTL_MS);
    return outcome;
  });

  return outcome;
}

export { StreamIdError };
