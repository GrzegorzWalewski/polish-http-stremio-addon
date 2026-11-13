# polish-http-stremio-addon

Stremio HTTP addon exposing stream links from 17 Polish streaming sites,
powered by [movies-series-fetcher](https://github.com/GrzegorzWalewski/polish-movies-and-series-fetcher).

Resolvable hosts (e.g. cda.pl) produce **direct playable URLs**; everything
else falls back to an **external link** that opens the site page in your
browser. No playback of premium content.

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
- `/stream/movie/tt0083564.json`
- `/stream/series/tt0903747:2:1.json`
- `/healthz` — status + last provider warnings

Errors are JSON: `400` malformed id, `503` missing TMDB token.

## Notes / limits

- Per-provider timeout is **25s** — filman.cc's rate-limit sleep (~60s)
  usually gets cut and shows up as a warning; query filman from the CLI
  instead when you need it.
- Hosts whose embeds can't be resolved degrade to external links
  automatically (hoster obfuscation changes often).
- Sites that are login/geo-gated (mm35, freedisc) or article-based (virpe)
  always return external links.
