/**
 * Minimal streaming proxy: some resolved streams (maxvod.tv signed MP4s)
 * require a Referer header that Stremio's player doesn't reliably send.
 * The addon rewrites those URLs to /proxy?… and forwards the required
 * headers itself, so the player only ever talks to localhost.
 */

import * as http from 'node:http';
import { Readable } from 'node:stream';

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[::\]|::1)/i;

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

  let upstream: Response;
  try {
    upstream = await fetch(parsed, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream fetch failed: ${(err as Error).message}` }));
    return;
  }

  const out: http.OutgoingHttpHeaders = {};
  for (const name of ['content-type', 'content-length', 'content-range']) {
    const v = upstream.headers.get(name);
    if (v) out[name] = v;
  }
  out['accept-ranges'] = 'bytes';
  res.writeHead(upstream.status, out);

  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    await Readable.fromWeb(upstream.body as never).pipe(res);
  } catch {
    // client disconnected mid-stream (seek) — nothing to clean up
    res.destroy();
  }
}
