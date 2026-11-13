# polish-http-stremio-addon

Stremio HTTP addon exposing stream links from 17 Polish streaming sites,
powered by [movies-series-fetcher](https://github.com/GrzegorzWalewski/polish-movies-and-series-fetcher).

Embed URLs from known hosters are resolved server-side into **direct playable
URLs**; everything else falls back to an **external link** that opens the site
page in your browser. No playback of premium content.

Currently resolvable hosters (all fail soft — an unresolvable embed just
stays an external link):

| Hoster | Reached via | Method |
|---|---|---|
| cda.pl | cda.pl provider | embed normalize + player_data decode |
| byse (rotating `byse*` domains) | bajeczki24, premiumsmart | proof-of-work captcha + AES-GCM playback payload |
| fsst.online & friends (filemoon, savefiles, luluvdo, bigwarp, strmup…) | seriale.vip, filman | P.A.C.K.E.R. unpack |
| voe / dood / vidmoly / vidoza | ekino, filman, seriale.vip | per-hoster decode |
| ok.ru | dokumentalne.net | `data-options` metadata → HLS |
| vod.tvp.pl | iitv.info (official TVP links) | TVP VOD JSON API → tokenized HLS |
| streamtape (mirrors) | (none currently) | ideoolink / `robot()` construction |

Hosters rotate domains and re-obfuscate often — the resolved set shrinks and
grows over time. Rows that stay unresolved are labeled `(open in browser)`.

## Setup

```bash
npm install          # links ../movies-series-fetcher via file: (builds it too)
cp .env.example .env # then fill in TMDB_READ_TOKEN (required)
npm run dev          # tsx dev server on :7777
```

Production:

```bash
npm run build        # builds fetcher dist first, then tsc
npm start
```

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `TMDB_READ_TOKEN` | yes | TMDB Read Access Token (JWT), imdb-id lookups |
| `FLARESOLVERR_URL` | no | auto Cloudflare bypass (zaluknij, cda-hd) — e.g. `http://localhost:8191` |
| `FILMAN_CC_COOKIE` / `FILMAN_CC_UA` | no | manual filman.cc session (see fetcher README) |
| `PORT` | no | HTTP port (default 7777) |

## Endpoints

- `/` — install landing page
- `/manifest.json` — Stremio manifest (`stream` resource, `movie` + `series`, `tt` prefix)
- `/stream/movie/tt0088083.json` — Seksmisja
- `/stream/series/tt0903747:2:1.json` — The Witcher S2E1
- `/healthz` — status + last provider warnings (`?limit=50` for more; default 10)

```json
{
  "status": "ok",
  "uptimeSeconds": 4212,
  "tmdbConfigured": true,
  "flaresolverrConfigured": false,
  "cachedStreams": 3,
  "lastWarnings": [
    { "at": "2026-11-13T11:20:00.000Z", "text": "filman.cc: …" }
  ]
}
```

`lastWarnings` is a debugging aid — one entry per provider error in recent
stream requests (Cloudflare walls, geo-blocks, captchas). Errors are JSON:
`400` malformed id, `503` missing TMDB token.

## Notes / limits

- Per-provider timeout is **25s** — filman.cc's rate-limit sleep (~60s)
  usually gets cut and shows up as a warning; query filman from the CLI
  instead when you need it.
- Hosts whose embeds can't be resolved degrade to external links
  automatically (hoster obfuscation changes often).
- Sites that are login/geo-gated (mm35, freedisc) or article-based (virpe)
  always return external links.
