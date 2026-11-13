import { MANIFEST } from './stremio.js';
import { providers } from 'movies-series-fetcher/lib';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function landingHtml(origin: string): string {
  const manifestUrl = `${origin}/manifest.json`;
  const names = providers.map((p) => escapeHtml(p.name));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polish Streams — Stremio addon</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1017; color: #e6e6ea;
         max-width: 640px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6; }
  h1 { font-size: 1.6rem; }
  .btn { display: inline-block; background: #8b5cf6; color: #fff; padding: .7rem 1.3rem;
         border-radius: .5rem; text-decoration: none; font-weight: 600; }
  .btn.copy { background: #2a2a35; cursor: pointer; border: none; font: inherit; }
  code { background: #1d1e28; padding: .15rem .4rem; border-radius: .3rem; word-break: break-all; }
  ul { columns: 2; }
  .note { color: #9a9aa8; font-size: .9rem; }
</style>
</head>
<body>
<h1>${escapeHtml(MANIFEST.name)}</h1>
<p>${escapeHtml(MANIFEST.description)}</p>
<p>
  <a class="btn" href="stremio://${manifestUrl.replace(/^https?:\/\//, '')}">Install in Stremio</a>
  <button class="btn copy" id="copy">Copy manifest URL</button>
</p>
<p>Manifest URL: <code id="murl">${escapeHtml(manifestUrl)}</code></p>
<h2>Providers (${names.length})</h2>
<ul>${names.map((n) => `<li>${n}</li>`).join('')}</ul>
<p class="note">No playback of premium content; unresolvable hosts open the site page in your browser.
Requires TMDB_READ_TOKEN (and optionally FLARESOLVERR_URL / FILMAN_CC_COOKIE) configured server-side in .env.</p>
<script>
  document.getElementById('copy').onclick = function () {
    navigator.clipboard.writeText(document.getElementById('murl').textContent);
    this.textContent = 'Copied';
  };
</script>
</body>
</html>`;
}
