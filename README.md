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
| `FLARESOLVERR_URL` | no | auto Cloudflare bypass (zaluknij, cda-hd, filman daily rotation) — e.g. `http://localhost:8191` |
| `FILMAN_CC_LOGIN` / `FILMAN_CC_PASSWORD` | no | filman.cc account for the auto-session (see fetcher README) |
| `TWOCAPTCHA_API_KEY` | no | 2captcha.com key — solves filman's reCAPTCHA only when its session expires (rare; cached in `.filman-session.json`) |
| `FILMAN_CC_COOKIE` / `FILMAN_CC_UA` | no | manual filman.cc session fallback, ignored while auto-session is configured |
| `PORT` | no | HTTP port (default 7777) |
| `ADDON_PUBLIC_URL` | no | public base URL (e.g. `https://polhttp.example.com`) — required with the Caddy setup so proxied stream URLs point at the domain, not `localhost` |

## Endpoints

Install URL: `http://<server-ip>:7777/manifest.json` (localhost only — Stremio requires HTTPS for anything else, see below).

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

- Per-provider timeout is **60s** — sized to fit a FlareSolverr Cloudflare
  solve (30–40s+ on weak CPUs) and filman.cc's rate-limit sleep (~60s). A
  cold request (cache miss, CF cookies expired) can take up to that long;
  results are cached for 30 min and solved CF cookies are persisted to disk,
  so steady-state requests are fast. The filman auto-session's first
  bootstrap (FlareSolverr + captcha login, ~1–2 min) still benefits from
  priming via one search from the fetcher CLI; afterwards the cached session
  keeps the addon's filman requests fast.
- Hosts whose embeds can't be resolved degrade to external links
  automatically (hoster obfuscation changes often).
- Sites that are login/geo-gated (mm35, freedisc) or article-based (virpe)
  always return external links.

## HTTPS (Caddy sidecar)

Stremio only accepts plain-HTTP addon URLs on `localhost`; any other address
needs HTTPS. The compose file includes a Caddy sidecar that terminates TLS and
proxies to the addon, using a **Cloudflare DNS-01 challenge** — so no inbound
port 80 is needed and the server can stay LAN-only.

1. Create a DNS A record in your Cloudflare zone pointing a hostname
   (e.g. `polhttp.example.com`) at your server, **grey-cloud** (DNS only).
2. Create a Cloudflare API token with `Zone → DNS → Edit` permission for that
   zone and put it in a **project-local gitignored `.env`** (this is separate
   from the fetcher's `.env`):
   ```
   CLOUDFLARE_API_TOKEN=your-token
   ```
3. Replace `polhttp.example.com` in the `Caddyfile` with your hostname, add
   `ADDON_PUBLIC_URL: https://polhttp.example.com` to the addon service's
   `environment:` in `docker-compose.yml`, and `docker compose up -d --build`
   as usual. Certificates renew automatically.

Install URL becomes: `https://polhttp.example.com/manifest.json`.

The Caddy image is built with the `caddy-dns/cloudflare` module
(`Dockerfile.caddy`, two-stage xcaddy build); cert data persists in the
`caddy-data` volume.
