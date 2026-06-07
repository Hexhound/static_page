# Cloudflare Worker — the reliable, free replacement for GitHub Actions

GitHub Actions' scheduled `cron` is best-effort: runs are frequently late (5–40 min)
or skipped under load. **Cloudflare Cron Triggers fire on time**, and this whole setup
is free at our volume.

```
  ┌─ Cloudflare Cron (hourly) ─┐   put    ┌──── KV ────┐   GET    ┌─ your page ─┐
  │  worker.mjs scheduled()    │ ──────►  │ tweets.json │ ──────► │  index.html  │
  │  calls twitter-api45       │          └────────────┘          │ fetch+render │
  └────────────────────────────┘   worker.mjs fetch() serves it   └──────────────┘
```

The Worker does three jobs: the **cron** refreshes KV on schedule AND downloads every
cover/avatar into KV; the **JSON handler** serves the cached tweets.json (CORS + 5-min
cache) with each image URL pointing at this Worker; the **/img/ handler** serves those
image bytes from KV (long, immutable cache). No git commits, no Pages rebuild — and
images load from your own edge instead of pbs.twimg.com + the wsrv.nl proxy.

## Why self-host images

The page used to load `pbs.twimg.com` through the third-party `wsrv.nl` proxy — **two**
external deps, either of which throttling = the broken-image placeholder you've been
seeing. The Worker now downloads each image once into KV (keyed by content hash, so
unchanged covers are never re-fetched) and serves them from your own origin. Reliable,
free, and the page bypasses the proxy automatically for same-origin images.

**Images are self-hosted too.** Each cover/avatar is downloaded once into the KV
namespace and the JSON is rewritten to point at the Worker's `/img/<hash>` route — so
the page loads images from your Worker's origin instead of hotlinking `pbs.twimg.com`
(which throttles → flaky images). Hash-keyed and cached forever; an image already in KV
is never re-fetched. Requires `PUBLIC_BASE` to be set (step 4b).

## Files
- `worker.mjs` — the Worker (reuses your exact parsing logic from `../fetch.mjs`).
- `wrangler.toml` — config: the hourly cron + KV binding + non-secret vars.

---

## Setup (~10 min, all free)

You need a free Cloudflare account and Node installed locally.

### 1. Install the CLI and log in
```bash
npm install -g wrangler
cd olhar-factual/x-fetcher/cloudflare
wrangler login
```

### 2. Create the KV namespace
```bash
wrangler kv namespace create TWEETS_KV
```
It prints an `id`. Paste it into `wrangler.toml` where it says
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

### 3. Add your RapidAPI key as a SECRET (never in any file)
```bash
wrangler secret put RAPIDAPI_KEY
# paste your twitter-api45 key when prompted
```

### 4. Deploy
```bash
wrangler deploy
```
You'll get a URL like `https://olhar-factual-x-fetcher.<you>.workers.dev`.

### 4b. Set PUBLIC_BASE, then redeploy
Paste that URL into `wrangler.toml` as `PUBLIC_BASE` and deploy again:
```bash
wrangler deploy
```
This is required so the **image** URLs the Worker writes into the JSON are absolute
(your page is cross-origin on GitHub Pages). Without it, images keep their remote
X-CDN urls.

### 5. Fill KV once (the cron only runs on the hour)
Open `https://olhar-factual-x-fetcher.<you>.workers.dev/?refresh=1` in a browser.
That forces a live pull and writes KV. You should see your `tweets.json` payload.

### 6. Point the page at the Worker
In `site/index.html`, change one line:
```js
var DATA_URL = 'tweets.json';
```
to your Worker URL:
```js
var DATA_URL = 'https://olhar-factual-x-fetcher.<you>.workers.dev';
```
The Worker already sends `Access-Control-Allow-Origin: *`, so the cross-origin fetch
from GitHub Pages just works. Nothing else in the page changes — it still expects the
same JSON shape, and the silent 3-min auto-refresh keeps working.

**Images:** once `DATA_URL` is the Worker URL, the page's `proxied()` helper recognises
images served from that same origin (the Worker's `/img/` route) and loads them directly
— skipping the wsrv.nl proxy. This edit is already in `site/index.html`. Images that
failed to download (rare) fall back to the remote twimg URL and still go through the
proxy, so nothing ever hard-breaks.

Done. The cron refreshes hourly; you can delete the GitHub Action
(`.github/workflows/fetch-x.yml`) whenever you're satisfied it's running.

---

## Staying free / under quota
- twitter-api45 free plan = **1,000 req/month**. Hourly cron = ~720/mo. Don't go below
  ~45-min intervals. Cron syntax in `wrangler.toml` is **UTC**.
- The JSON handler serves from KV (no RapidAPI call), so visitor traffic does **not**
  burn quota — only the cron does. Predictable spend.
- Workers free tier: 100k requests/day. KV free tier = **1k writes/day + 100k reads/day**.
  The hourly cron writes 1 JSON + only NEW images (deduped by hash; covers rarely
  change), so ~25–50 writes/day — well under the cap. Images are served by KV *reads*,
  which are effectively free at this volume.
- KV value limit is 25 MB; X covers are well under 1 MB. If you ever store a large
  media library, switch the image blobs to an **R2 bucket** (10 GB free, free egress) —
  same code shape, swap `TWEETS_KV.put/get` for an R2 binding on the `/img/` paths.

## Notes
- Want a real path instead of the bare domain? Add a route in `wrangler.toml` or use a
  custom domain, then set `DATA_URL` to e.g. `https://api.olharfactual.com/tweets.json`.
- The `?refresh=1` query param forces a live pull on demand — handy for the first run
  or after editing the handle. Normal requests always read the cached KV copy.
- Same caveat as the Action: `timeline.php` returns truncated text, so the **bias bar**
  (`coverage`) is `null` for live posts unless you feed full article bodies in. See the
  parent `../README.md` → "Coverage data".

## Alternative: Cloudflare Pages Function (if you move hosting to CF Pages)
If you'd rather host the whole site on Cloudflare Pages, skip the cron and KV entirely:
add `functions/tweets.json.js` that calls `buildTweetsJSON()` live and returns it with a
5–10 min `Cache-Control`. Then `DATA_URL` stays `'tweets.json'` and resolves to the
Function. Quota then scales with traffic instead of time — fine for low traffic, riskier
if you get a spike. The cron-Worker approach above is the safer default.
