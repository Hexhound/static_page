# Filling `tweets.json` from your X account

The page **`index.html`** renders whatever it finds in **`tweets.json`** (sitting next
to it). It needs no backend at runtime — it just reads that one file from your own
domain. So the only job left is: *keep `tweets.json` fresh from X.*

We use the **twitter-api45** proxy on RapidAPI (free plan = **1,000 requests/month**),
so you skip the official X API and its ~US$200/mo read tier entirely.

> 🔑 **Security rule:** your RapidAPI key must live **server-side / build-time** only —
> as a GitHub Actions secret. **Never** put it in the page's JavaScript: anyone could
> view-source, steal it, and burn your quota.

---

## How it fits together

```
  ┌─ GitHub Action (hourly) ─┐        commits          ┌─ GitHub Pages ─┐
  │  fetch.mjs               │  ───►  tweets.json  ───► │  index.html │
  │  calls twitter-api45     │                          │  fetch + render │
  └──────────────────────────┘                          └─────────────────┘
        key = repo secret                                  no backend, no key
```

The page never talks to X or RapidAPI directly — it only reads your own `tweets.json`.

---

## Setup (GitHub Pages — ~10 min)

### 1. Get a RapidAPI key
- Sign up at rapidapi.com, open **https://rapidapi.com/alexanderxbx/api/twitter-api45**,
  and **Subscribe** to the **Basic / Free** plan (1,000 req/month).
- Copy your key from the **`X-RapidAPI-Key`** header shown in the playground.

### 2. Add the key as a repo secret
In your repo: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `RAPIDAPI_KEY`
- Value: *your key*

### 3. Drop in the two files from this folder
- `x-fetcher/fetch.mjs` → keep at `x-fetcher/fetch.mjs`
- `fetch-x.yml` → move to **`.github/workflows/fetch-x.yml`**

If your site isn't served from the repo root, change `OUT_PATH` in the workflow
(default: `tweets.json`).

### 4. Run it
Push, then open the **Actions** tab → **Fetch X posts** → **Run workflow**.
It pulls your timeline, writes `tweets.json`, and commits it. After that it runs
**hourly** on its own. Done — the page stays current with zero further work.

### Staying under the free cap
One timeline call ≈ **1 request** and returns ~20 posts. The workflow runs **hourly**
(~720/month). Don't drop below ~45-min intervals or you'll exceed 1,000/month.

---

## The data shape (for reference)

```json
{
  "account": {
    "name": "Olhar Factual", "handle": "OlharFactual", "url": "https://x.com/OlharFactual",
    "avatar": "https://pbs.twimg.com/profile_images/.../..._400x400.jpg",
    "bio": "A mesma notícia. Todos os lados. ...",
    "followers": 31, "posts_count": 88
  },
  "fetched_at": "2026-06-03T12:00:00Z",
  "posts": [
    {
      "id": "2062185996288967006",
      "title": "Governo Lula anuncia um novo polo naval",
      "summary": "Elio Gaspari escreveu uma coluna sobre o novo polo naval...",
      "lenses": 2,
      "created_at": "2026-06-03T14:53:49Z",
      "url": "https://x.com/OlharFactual/status/2062185996288967006",
      "media": ["https://pbs.twimg.com/media/....jpg"],
      "media_alt": "Governo Lula anuncia um novo polo naval",
      "likes": 0, "reposts": 0, "replies": 0, "views": 5
    }
  ]
}
```

- Each post is an X **Article**: `title` is the headline, `summary` is the
  "A MESMA NOTÍCIA…" comparison deck, and `lenses` (2, 3, …) drives the
  "Duas/Três lentes diferentes" kicker on every card.
- `coverage` / `sources` / `coverage_kind` are parsed from the article's
  "Dados da cobertura" block (see **Coverage data** below). When present, the card
  renders the **bias bar** instead of the lens kicker.
- The first post becomes the hero; posts 2–4 the three-up row; the rest the grid.
- Empty `media` → the card renders as a clean text-only headline. Cover images that
  fail to load fall back to an on-brand lens placeholder.
- `fetch.mjs` produces this shape automatically from the RapidAPI response — you
  normally never edit it by hand. A captured `sample-response.json` (the raw API
  payload) sits in this folder for reference/testing.

---

## Coverage data (the bias bar)

Your articles carry a coverage breakdown the page turns into the signature bias bar:

```
Dados da cobertura:
🔴 Esquerda: 0 artigo(s) — nenhum outlet identificado
⚪ Centro: 8 artigo(s) de 4 outlet(s) — G1, O Globo, Veja, Poder360
🟢 Direita: 0 artigo(s) — nenhum outlet identificado
```

`parseCoverage()` (in `fetch.mjs`, mirrored in the page) extracts this into:

```json
"coverage_kind": "blindspot",          // "blindspot" (COBERTURA ASSIMÉTRICA) or "comparison" (A MESMA NOTÍCIA)
"coverage": {
  "left":   { "count": 0, "outlets": [] },
  "center": { "count": 8, "outlets": ["G1", "O Globo", "Veja", "Poder360"] },
  "right":  { "count": 0, "outlets": [] }
},
"sources": [ { "outlet": "G1", "lean": "center", "url": "https://g1.globo.com/..." } ]
```

The parser is wrapped in `try/catch` and tolerant of the 𝗯𝗼𝗹𝗱-𝘂𝗻𝗶𝗰𝗼𝗱𝗲 headers and
🔴⚪🟢 markers — **if anything fails to parse it returns `null`** and the card simply
falls back to the lens kicker. Nothing breaks.

### ⚠️ Important: timeline returns TRUNCATED text
The `timeline.php` endpoint returns a shortened `preview_text` that usually **cuts off
before** the "Dados da cobertura" block — so coverage will be `null` for live posts
fetched this way (they still render fine, just without the bar). To populate the bias
bar in production you need the **full article body**, via one of:
- a per-article detail call (if your API plan exposes article content), fed into
  `parseCoverage()` — `fetch.mjs` already looks for `full_text` / `note_tweet.text`;
- or your own backend that generates these articles (it already has the structured
  counts — write them straight into `tweets.json`).

The committed `tweets.json` includes one fully-parsed **blindspot example** (the
Trajano de Moraes case) as the hero so you can see the bias-bar treatment live.

---

## Cloudflare Pages alternative (live, no committing)

Prefer not to commit on a cron? On **Cloudflare Pages**, add a Pages Function at
`functions/tweets.json.js` that calls twitter-api45 with the key from a secret env var
and returns the same JSON shape (add a short `Cache-Control`, e.g. 5–10 min, to protect
your quota). The page's `fetch('tweets.json')` then hits your function instead of a
static file — nothing in the page changes.

---

## Troubleshooting
- **403 / "not subscribed"** — you haven't subscribed to the plan, or the key is wrong.
- **Empty `posts`** — check the handle in the workflow `X_HANDLE`. The script logs the
  raw response keys when the timeline is empty.
- **Page shows the error state** — make sure `tweets.json` is actually published next to
  `index.html` (same folder) and the Action committed it.
