import * as http from 'node:http';
import { loadEnvFile } from 'movies-series-fetcher/lib';
import { MANIFEST, parseStreamId, StreamIdError, streamResponse } from './stremio.js';
import { getStreams, lastWarnings, streamCacheSize, UpstreamNotFoundError } from './handler.js';
import { landingHtml } from './landing.js';
import { handleProxy } from './proxy.js';

loadEnvFile();

const PORT = Number(process.env.PORT ?? 7777);
const startedAt = Date.now();

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  setCors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function requiresTmdb(res: http.ServerResponse): boolean {
  if (process.env.TMDB_READ_TOKEN) return false;
  sendError(
    res,
    503,
    'TMDB_READ_TOKEN is not set. Copy .env.example to .env and add a Read Access Token (JWT) from themoviedb.org.'
  );
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (path === '/proxy') {
      await handleProxy(req, res, url);
      return;
    }

    if (path === '/' || path === '/landing') {
      sendHtml(res, landingHtml(`http://localhost:${PORT}`));
      return;
    }

    if (path === '/healthz') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 0), 50);
      sendJson(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        tmdbConfigured: !!process.env.TMDB_READ_TOKEN,
        flaresolverrConfigured: !!process.env.FLARESOLVERR_URL,
        cachedStreams: streamCacheSize(),
        lastWarnings: lastWarnings
          .slice(0, limit)
          .map((w) => ({ at: new Date(w.at).toISOString(), text: w.text })),
      });
      return;
    }

    const manifestMatch = path === '/manifest.json';
    if (manifestMatch) {
      sendJson(res, 200, MANIFEST);
      return;
    }

    // /stream/{movie|series}/{id}.json
    const m = /^\/stream\/(movie|series)\/([^/]+)$/.exec(path);
    if (m) {
      if (requiresTmdb(res)) return;
      const parsed = parseStreamId(m[1], m[2]);
      const outcome = await getStreams(parsed);
      sendJson(res, 200, streamResponse(outcome.streams));
      return;
    }

    sendError(res, 404, `Unknown path ${path}`);
  } catch (err) {
    if (err instanceof StreamIdError) {
      sendError(res, 400, err.message);
    } else if (err instanceof UpstreamNotFoundError) {
      // valid id, nothing on TMDB — Stremio convention: empty stream list
      sendJson(res, 200, { streams: [] });
    } else if (err instanceof Error && err.name === 'TmdbAuthError') {
      sendError(res, 503, err.message);
    } else {
      console.error(`${new Date().toISOString()} ${path}:`, err);
      sendError(res, 500, 'Internal error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`polish-http-stremio-addon listening on http://localhost:${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  if (!process.env.TMDB_READ_TOKEN) {
    console.warn('TMDB_READ_TOKEN is not set — stream requests will return 503.');
  }
});
