/**
 * Local streaming proxy for resolved streams. All playable rows are routed
 * through here so that:
 *   1. header-gated media (maxvod signed MP4s need a Referer) works — the
 *      addon attaches the headers, the player only talks to localhost;
 *   2. progressive media can be pre-warmed: the first PREFETCH_BYTES are
 *      fetched the moment the stream URL is known, so the player's first
 *      range request is served from memory instantly.
 */

import * as http from 'node:http';
import { Readable } from 'node:stream';

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[::\]|::1)/i;

/** Time allowed for upstream HEADERS to arrive (body streaming is unbounded). */
const CONNECT_TIMEOUT_MS = 30_000;

/** Warm-up cache: first bytes of progressive media, served instantly. */
const PREFETCH_BYTES = 3 * 1024 * 1024;
const PREFETCH_TTL_MS = 15 * 60 * 1000;

interface WarmEntry {
  status: number;
  /** upstream headers worth replaying (content-type etc.) */
  contentType: string | null;
  /** total media size in bytes (null when unknown) */
  total: number | null;
  data: Buffer;
  at: number;
}

const warm = new Map<string, WarmEntry>();

function warmFresh(entry: WarmEntry | undefined): entry is WarmEntry {
  return !!entry && Date.now() - entry.at < PREFETCH_TTL_MS;
}

function isProgressiveMedia(url: string): boolean {
  return /\.(mp4|mkv|avi|webm)(\?|#|$)/i.test(url);
}

/**
 * Fire-and-forget pre-fetch of the first PREFETCH_BYTES of a progressive
 * media URL. Called from the resolver stage the moment a stream is known —
 * the player then starts on locally cached bytes instead of a cold CDN.
 */
export function warmUp(target: string, headers?: Record<string, string>): void {
  if (!isProgressiveMedia(target) || warmFresh(warm.get(target))) return;
  warm.delete(target);

  void (async () => {
    const res = await fetch(target, {
      headers: {
        'accept-encoding': 'identity',
        Range: `bytes=0-${PREFETCH_BYTES - 1}`,
        ...headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 206) return;

    const chunks: Buffer[] = [];
    let got = 0;
    for await (const chunk of res.body!) {
      const buf = Buffer.from(chunk as Buffer);
      chunks.push(buf);
      got += buf.length;
      if (got >= PREFETCH_BYTES) break;
    }
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) ||
      Number(res.headers.get('content-length')) || null;
    warm.set(target, {
      status: res.status,
      contentType: res.headers.get('content-type'),
      total,
      data: Buffer.concat(chunks),
      at: Date.now(),
    });
  })().catch(() => {
    /* warm-up is best-effort — normal proxy path still works */
  });
}

export function proxyUrlFor(
  baseUrl: string,
  target: string,
  headers?: Record<string, string>
): string {
  const u = new URL('/proxy', baseUrl);
  u.searchParams.set('u', target);
  if (headers && Object.keys(headers).length > 0) {
    u.searchParams.set(
      'h',
      Buffer.from(JSON.stringify(headers)).toString('base64url')
    );
  }
  return u.toString();
}

const HLS_CT_RE = /mpegurl/i;

/** Base URL of this server as the calling player sees it. */
function selfBaseUrl(req: http.IncomingMessage): string {
  return `http://${req.headers.host ?? `localhost:${process.env.PORT ?? 7777}`}`;
}

/**
 * Rewrite relative URIs in an HLS playlist to absolute proxy URLs. Without
 * this, a player resolving `seg_00001.ts` against
 * `http://localhost:7777/proxy?u=...` hits the addon router instead of the
 * proxy and the stream breaks. Absolute URIs (byse variant playlists point
 * straight at their CDN) are left untouched — those segments flow directly,
 * which is faster than looping through localhost.
 */
function rewritePlaylist(
  body: string,
  upstream: URL,
  baseUrl: string,
  h: string | null
): string {
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      try {
        const abs = new URL(t, upstream).href;
        const p = new URL('/proxy', baseUrl);
        p.searchParams.set('u', abs);
        if (h) p.searchParams.set('h', h);
        return p.toString();
      } catch {
        return line;
      }
    })
    .join('\n');
}

function upstreamHeaders(req: http.IncomingMessage, url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    'accept-encoding': 'identity', // no gzip — range math must stay linear
  };
  const h = url.searchParams.get('h');
  if (h) {
    try {
      Object.assign(headers, JSON.parse(Buffer.from(h, 'base64url').toString('utf-8')));
    } catch {
      /* bad header blob — proceed without */
    }
  }
  if (req.headers.range) headers.Range = req.headers.range;
  return headers;
}

/** fetch with a connect-phase timeout — body streaming is never aborted. */
async function fetchUpstream(
  target: URL,
  headers: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await fetch(target, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    // headers arrived (or threw) — the body may stream for minutes
    clearTimeout(timer);
  }
}

async function pipeBody(
  body: ReadableStream | null,
  res: http.ServerResponse
): Promise<void> {
  if (!body) {
    res.end();
    return;
  }
  try {
    await Readable.fromWeb(body as never).pipe(res);
  } catch {
    res.destroy(); // client seek/disconnect — nothing to clean up
  }
}

export async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const target = url.searchParams.get('u');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing ?u=' }));
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid url' }));
    return;
  }
  if (!/^https?:$/.test(parsed.protocol) || BLOCKED_HOSTS.test(parsed.hostname)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'url not allowed' }));
    return;
  }

  const range = req.headers.range;
  const headers = upstreamHeaders(req, url);

  // ---- warm start: open-ended byte-0 request hits the prefetch cache ----
  const entry = warm.get(parsed.href);
  if (warmFresh(entry) && entry.data.length > 0 && (!range || /^bytes=0-$/.test(range))) {
    const total = entry.total ?? entry.data.length;
    // We deliver the WHOLE resource (cached chunk + live splice), so the
    // range advertised must span all of it — a 206 whose content-range ends
    // at the cache boundary while content-length says "full file" confuses
    // strict clients.
    res.writeHead(range ? 206 : 200, {
      'content-type': entry.contentType ?? 'application/octet-stream',
      'content-length': String(total),
      ...(range ? { 'content-range': `bytes 0-${total - 1}/${total}` } : {}),
      'accept-ranges': 'bytes',
    });
    res.write(entry.data);
    if (total <= entry.data.length) {
      res.end();
      return;
    }
    // remainder streams live from the CDN starting after the cached chunk
    try {
      const rest = await fetchUpstream(parsed, {
        ...headers,
        Range: `bytes=${entry.data.length}-`,
      });
      await pipeBody(rest.body, res);
    } catch {
      res.end();
    }
    return;
  }

  // ---- normal path: fetch and stream through ----
  let upstream: Response;
  try {
    upstream = await fetchUpstream(parsed, headers);
  } catch (err) {
    console.error(`${new Date().toISOString()} proxy: upstream failed for ${parsed.host}: ${(err as Error).message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream fetch failed' }));
    return;
  }

  if (upstream.status >= 400) {
    console.error(`${new Date().toISOString()} proxy: upstream ${upstream.status} for ${parsed.host}${parsed.pathname.slice(0, 40)}`);
  }

  const out: http.OutgoingHttpHeaders = {};
  for (const name of ['content-type', 'content-length', 'content-range']) {
    const v = upstream.headers.get(name);
    if (v) out[name] = v;
  }
  out['accept-ranges'] = 'bytes';

  // HLS playlists: rewrite relative URIs so segments keep flowing through
  // the proxy (or straight to the CDN when the playlist uses absolute URIs)
  const ct = upstream.headers.get('content-type') ?? '';
  const isHls =
    HLS_CT_RE.test(ct) || /\.m3u8(\?|#|$)/i.test(parsed.pathname + parsed.search);
  if (isHls && upstream.ok && upstream.body) {
    const text = await upstream.text();
    const body = rewritePlaylist(
      text,
      parsed,
      selfBaseUrl(req),
      url.searchParams.get('h')
    );
    delete out['content-range'];
    out['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(upstream.status, out);
    res.end(body);
    return;
  }

  res.writeHead(upstream.status, out);
  await pipeBody(upstream.body, res);
}
