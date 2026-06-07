/**
 * Olhar Factual — X → tweets.json fetcher, as a Cloudflare Worker.
 * ----------------------------------------------------------------------------
 * Drop-in replacement for the GitHub Action, now with SELF-HOSTED IMAGES.
 *
 * Three jobs, one Worker:
 *   scheduled()      — Cron Trigger. Calls twitter-api45, parses the timeline,
 *                      DOWNLOADS every cover/avatar into KV, rewrites the JSON to
 *                      point at this Worker's own /img/ route, stores JSON in KV.
 *   fetch() /        — serves the cached tweets.json (CORS + short cache), with
 *                      every image URL absolutised to THIS worker's origin.
 *   fetch() /img/..  — serves an image straight from KV (long, immutable cache).
 *
 * Why self-host images: the page used to load pbs.twimg.com through the wsrv.nl
 * proxy — TWO third-party deps, either of which throttling = broken covers. Now
 * the bytes live on your own origin (Cloudflare edge) and load every time.
 *
 * Bindings (wrangler.toml + dashboard):
 *   KV namespace:  TWEETS_KV     (holds both tweets.json AND the image blobs)
 *   Secret:        RAPIDAPI_KEY  (npx wrangler secret put RAPIDAPI_KEY)
 *   Vars:          X_HANDLE, MAX_POSTS  (optional)
 *
 * Free tier: Workers 100k req/day; KV 1k writes/day + 100k reads/day free.
 * One hourly cron writes ~1 JSON + only NEW images (deduped by content hash),
 * so writes stay well under the cap. Images are served from KV reads (free,
 * fast) and never touch RapidAPI or twimg again.
 */

const RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';
const KV_KEY        = 'tweets.json';
const IMG_PREFIX    = 'img/';          // KV key prefix for image blobs
const IDX_KEY       = '__img_index__'; // KV key: JSON array of stored image names

/* ───────────────────────── parsing (ported verbatim from fetch.mjs) ──────── */

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
  return Number.isFinite(n) ? n : null;
}
function toISO(created_at) {
  if (!created_at) return undefined;
  const d = new Date(created_at);
  return isNaN(d) ? undefined : d.toISOString();
}
function bigAvatar(u) { return u ? u.replace('_normal.', '_400x400.') : u; }

function normalizeBold(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1D5D4 && c <= 0x1D5ED) out += String.fromCharCode(65 + (c - 0x1D5D4));
    else if (c >= 0x1D5EE && c <= 0x1D607) out += String.fromCharCode(97 + (c - 0x1D5EE));
    else if (c >= 0x1D7EC && c <= 0x1D7F5) out += String.fromCharCode(48 + (c - 0x1D7EC));
    else out += ch;
  }
  return out;
}
const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const LEAN_BY_EMOJI = { '🔴': 'left', '🔵': 'left', '⚪': 'center', '⚫': 'center', '🟢': 'right' };
const SIDE_KEY = { ESQUERDA: 'left', CENTRO: 'center', DIREITA: 'right' };
const cleanOutlet = (s) => String(s).replace(/^[\s🔴🔵⚪⚫🟢•·*]+/, '').replace(/[•·*]/g, '').trim();
const trimOutlet = (s) => cleanOutlet(s).replace(/\s+\d+$/, '');

function parseSources(text) {
  const i = text.search(/Fontes\s*:/i);
  const region = i >= 0 ? text.slice(i) : '';
  const out = [];
  const re = /([🔴🔵⚪⚫🟢])?\s*([^\n–-]+?)\s*[–-]\s*(https?:\/\/\S+)/g;
  let m;
  while ((m = re.exec(region))) {
    const lean = m[1] ? (LEAN_BY_EMOJI[m[1]] || null) : null;
    const outlet = cleanOutlet(m[2]);
    if (outlet && m[3]) out.push({ outlet, lean, url: m[3] });
  }
  return out;
}
function parseCoverage(rawText) {
  try {
    if (!rawText) return null;
    const text = normalizeBold(rawText);
    const flat = stripAccents(text);
    let kind = null;
    if (/COBERTURA ASSIM/i.test(flat)) kind = 'blindspot';
    else if (/A MESMA NOTICIA/i.test(flat)) kind = 'comparison';
    const sides = { left: { count: 0, outlets: [] }, center: { count: 0, outlets: [] }, right: { count: 0, outlets: [] } };
    let m, found = false;

    // Format A — explicit counts: "Esquerda: 8 artigo(s) de 4 outlet(s) — G1, O Globo" (blindspot posts).
    const reA = /(Esquerda|Centro|Direita)\s*:\s*(\d+)\s*artigo\(s\)(?:\s*de\s*(\d+)\s*outlet\(s\))?\s*(?:[—–-]\s*([^\n]+))?/gi;
    while ((m = reA.exec(text))) {
      found = true;
      const key = SIDE_KEY[stripAccents(m[1]).toUpperCase()];
      const tail = (m[4] || '').trim();
      const outlets = (tail && !/nenhum outlet/i.test(tail)) ? tail.split(/[,;]/).map(trimOutlet).filter(Boolean) : [];
      sides[key] = { count: parseInt(m[2], 10) || 0, outlets };
    }

    // Format B — outlets in parentheses: "🔴 Esquerda (Folha, Carta, UOL): …" (comparison posts).
    if (!found) {
      const reB = /(?:[\n\r]|^)\s*[^\sA-Za-z]*\s*(Esquerda|Centro|Direita)\s*\(([^)\n]+)\)/g;
      while ((m = reB.exec(text))) {
        const key = SIDE_KEY[stripAccents(m[1]).toUpperCase()];
        if (!key) continue;
        const list = m[2].split(/[,;]/).map(trimOutlet).filter(Boolean);
        const seen = new Set(), uniq = [];
        for (const o of list) { const k = stripAccents(o).toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(o); } }
        sides[key] = { count: uniq.length, outlets: uniq };
        found = true;
      }
    }

    const sources = parseSources(text);
    if (!found) return kind ? { kind, coverage: null, sources } : null;
    const leanOf = {};
    for (const k of ['left', 'center', 'right']) for (const o of sides[k].outlets) leanOf[stripAccents(o).toLowerCase()] = k;
    for (const s of sources) if (!s.lean) s.lean = leanOf[stripAccents(s.outlet).toLowerCase()] || null;
    return { kind: kind || 'comparison', coverage: sides, sources };
  } catch (e) {
    return null;
  }
}

const LENS_MAP = { UMA: 1, DUAS: 2, 'TRÊS': 3, TRES: 3, QUATRO: 4, CINCO: 5 };
function parsePreview(pv) {
  if (!pv) return { lenses: null, summary: '' };
  let lenses = null;
  const m = pv.match(/A MESMA NOT[IÍ]CIA,\s*([A-ZÀ-Ÿ]+|\d+)\s*LENTES/i);
  if (m) { const k = m[1].toUpperCase(); lenses = LENS_MAP[k] || parseInt(m[1], 10) || null; }
  const nl = pv.indexOf('\n');
  const summary = nl >= 0
    ? pv.slice(nl + 1).trim()
    : pv.replace(/^🔍?\s*A MESMA NOT[IÍ]CIA,.*?DIFERENTES\s*/i, '').trim();
  return { lenses, summary };
}
function cleanTitle(t) {
  return String(t || '').replace(/\s*🔍?\s*A MESMA NOT[IÍ]CIA,.*$/i, '').trim();
}
function collectMedia(t) {
  const media = [];
  let alt = '';
  const m = t.media || t.entities?.media || {};
  const buckets = [];
  if (Array.isArray(m)) buckets.push(m);
  else { if (m.photo) buckets.push(m.photo); if (m.video) buckets.push(m.video); if (m.animated_gif) buckets.push(m.animated_gif); }
  for (const bucket of buckets) {
    for (const item of (bucket || [])) {
      const src = item.media_url_https || item.media_url || item.url || item.preview_image_url || item.thumbnail;
      if (src) { media.push(src); if (!alt && (item.alt_text || item.ext_alt_text)) alt = item.alt_text || item.ext_alt_text; }
    }
  }
  return { media, alt };
}

/* ───────────────────────── image localizer (→ KV) ─────────────────────────
 * Download a remote image, store the bytes in KV under "img/<hash>.<ext>", and
 * return that RELATIVE path. At serve time the path is absolutised to this
 * Worker's origin, so the page loads "https://<worker>/img/<hash>.jpg" — your
 * own edge, no twimg, no wsrv.nl.
 *
 * - Name = sha1(url) → stable, so an unchanged image is reused, not re-written.
 * - `index` (a Set loaded once per run) tracks what's already in KV → dedupe.
 * - Any failure falls back to the original remote URL — never breaks a refresh.
 * ------------------------------------------------------------------------- */
const CT_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function extFor(url) {
  try {
    const u = new URL(url);
    const fmt = (u.searchParams.get('format') || '').toLowerCase();
    if (fmt) return '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
    const m = u.pathname.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i);
    if (m) return '.' + (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase());
  } catch { /* fall through */ }
  return '.jpg';
}

function makeLocalizer(env, index, usedNames) {
  const cache = new Map(); // url -> local path, dedupe within a run
  return async function localizeImage(url) {
    if (!url || !/^https?:\/\//i.test(url)) return url;
    if (cache.has(url)) return cache.get(url);

    const name = (await sha1Hex(url)).slice(0, 16) + extFor(url);
    const key = IMG_PREFIX + name;
    const localPath = IMG_PREFIX + name; // e.g. "img/ab12cd34ef.jpg" (relative)
    usedNames.add(name);

    if (index.has(name)) { cache.set(url, localPath); return localPath; } // already in KV

    try {
      // Ask twimg for the large rendition for crisp covers.
      let fetchUrl = url;
      if (/pbs\.twimg\.com\/media\//i.test(url) && !/[?&]name=/i.test(url)) {
        fetchUrl += (url.includes('?') ? '&' : '?') + 'name=large';
      }
      const r = await fetch(fetchUrl, { headers: { 'User-Agent': 'olhar-factual-fetcher' }, cf: { cacheTtl: 0 } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const bytes = await r.arrayBuffer();
      const ct = r.headers.get('content-type') || CT_BY_EXT[extFor(url)] || 'image/jpeg';
      await env.TWEETS_KV.put(key, bytes, { metadata: { ct } });
      index.add(name);
      cache.set(url, localPath);
      console.log(`  ↓ image ${name} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
      return localPath;
    } catch (e) {
      console.warn(`  ! image download failed, keeping remote url (${e.message}): ${url}`);
      cache.set(url, url);
      return url; // graceful fallback — page still gets a (remote) image
    }
  };
}

/* ── full-body enrichment (same approach as fetch.mjs) ──────────────────────
 * Timeline gives only a truncated preview_text; the coverage block lives in the
 * full body. Try `tweet.php?id=` best-effort, store the raw payload, pick the
 * longest text. Cached via the previous KV JSON + budgeted so quota stays safe.
 * ------------------------------------------------------------------------- */
function timelineText(t) {
  return (t.article && (t.article.full_text || t.article.preview_text))
      || (t.note_tweet && t.note_tweet.text) || t.full_text || t.text || '';
}
function longestText(obj, best = '') {
  if (typeof obj === 'string') return obj.length > best.length ? obj : best;
  if (obj && typeof obj === 'object') for (const v of Object.values(obj)) best = longestText(v, best);
  return best;
}
function detailText(d) {
  if (!d) return '';
  const a = d.article || (d.tweet && d.tweet.article) || null;
  const cands = [
    a && (a.full_text || a.content || a.text || a.preview_text),
    d.note_tweet && (d.note_tweet.text
      || (d.note_tweet.note_tweet_results && d.note_tweet.note_tweet_results.result && d.note_tweet.note_tweet_results.result.text)),
    d.full_text, d.display_text, d.text,
  ].filter((s) => typeof s === 'string');
  let best = '';
  for (const c of cands) if (c.length > best.length) best = c;
  if (a) best = longestText(a, best);
  return best;
}
async function fetchDetail(env, id) {
  const u = `https://${RAPIDAPI_HOST}/tweet.php?id=${encodeURIComponent(id)}`;
  const r = await fetch(u, { headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
// True only when the text has PARSEABLE coverage data (sides + outlets/counts).
// Must NOT merely match the "COBERTURA ASSIMÉTRICA" title — that string is in the
// truncated blindspot preview too, which would wrongly skip the full-body fetch.
const hasCoverageData = (s) => { const c = parseCoverage(s); return !!(c && c.coverage); };

/* ──────────────────────── core: fetch + normalize → object ──────────────
 * Returns the data object with media as RELATIVE "img/…" paths. Absolutising to
 * the worker origin happens at serve time (so the same KV copy works on any URL).
 * ------------------------------------------------------------------------- */
async function buildTweetsData(env) {
  const HANDLE    = env.X_HANDLE || 'olharfactual';
  const MAX_POSTS = Math.max(1, parseInt(env.MAX_POSTS || '20', 10));
  if (!env.RAPIDAPI_KEY) throw new Error('Missing RAPIDAPI_KEY secret.');

  const url = `https://${RAPIDAPI_HOST}/timeline.php?screenname=${encodeURIComponent(HANDLE)}`;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
  });
  if (!res.ok) throw new Error(`RapidAPI error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];

  const posts = timeline
    .filter((t) => t.article && !t.retweeted && !t.is_retweet)
    .slice(0, MAX_POSTS)
    .map((t) => {
      const id = t.tweet_id || t.id_str || t.id;
      const base = {
        id: String(id),
        url: `https://x.com/${HANDLE}/status/${id}`,
        created_at: toISO(t.created_at),
        likes:   num(t.favorites ?? t.favorite_count ?? t.likes),
        reposts: num(t.retweets ?? t.retweet_count),
        replies: num(t.replies ?? t.reply_count),
        views:   num(t.views),
      };
      if (t.article) {
        const { lenses, summary } = parsePreview(t.article.preview_text);
        const title = cleanTitle(t.article.title);
        const fullText = t.article.full_text || t.note_tweet?.text || t.article.preview_text || '';
        const cov = parseCoverage(fullText);
        return {
          ...base, __src: t, title, summary, lenses,
          media: t.article.cover_media ? [t.article.cover_media] : [],
          media_alt: title,
          coverage_kind: cov ? cov.kind : 'comparison',
          coverage: cov ? cov.coverage : null,
          sources: cov ? cov.sources : [],
        };
      }
      const text = (t.text || t.full_text || '').replace(/https?:\/\/\S+/g, '').trim();
      const { media, alt } = collectMedia(t);
      const covPlain = parseCoverage(t.text || t.full_text || '');
      return {
        ...base, __src: t, title: text, summary: '', lenses: null, media, media_alt: alt,
        coverage_kind: covPlain ? covPlain.kind : null,
        coverage: covPlain ? covPlain.coverage : null,
        sources: covPlain ? covPlain.sources : [],
      };
    });

  const u = data.user || {};
  const out = {
    account: {
      name: u.name || 'Olhar Factual',
      handle: HANDLE,
      url: `https://x.com/${HANDLE}`,
      avatar: bigAvatar(u.avatar),
      bio: (u.desc || '').replace(/\n/g, ' '),
      followers: num(u.sub_count ?? u.followers_count),
      posts_count: num(u.statuses_count),
    },
    fetched_at: new Date().toISOString(),
    posts,
  };

  // ── Enrich with full body text + raw payload (page parses coverage at runtime).
  const FETCH_DETAIL  = env.FETCH_DETAIL !== '0';
  const DETAIL_BUDGET = Math.max(0, parseInt(env.DETAIL_BUDGET || '15', 10));
  const prevById = new Map();
  try {
    const prev = JSON.parse((await env.TWEETS_KV.get(KV_KEY)) || '{}');
    for (const p of (prev.posts || [])) prevById.set(String(p.id), p);
  } catch { /* no cache yet */ }

  let detailSpent = 0;
  const MAX_DETAIL_TRIES = 5; // retry transient failures, but never loop forever
  for (const p of out.posts) {
    const t = p.__src || {};
    const cached = prevById.get(String(p.id));
    let full = timelineText(t);
    if (cached && typeof cached.full_text === 'string' && cached.full_text.length > full.length) full = cached.full_text;
    let detailRaw = (cached && cached.raw && cached.raw.detail) || null;
    let tries = (cached && cached._dt) || 0;
    // Fetch the body while we still lack parseable coverage AND have no detail payload.
    // A failed/empty fetch is NOT marked done, so transient RapidAPI errors retry next
    // run (capped at MAX_DETAIL_TRIES). This is what was starving the blindspot posts.
    if (FETCH_DETAIL && !detailRaw && !hasCoverageData(full) && tries < MAX_DETAIL_TRIES && detailSpent < DETAIL_BUDGET) {
      try {
        detailSpent++;
        const d = await fetchDetail(env, p.id);
        if (d) detailRaw = d;
        const dt = detailText(detailRaw);
        if (dt && dt.length > full.length) full = dt;
      } catch (e) {
        console.warn(`detail fetch failed for ${p.id} (try ${tries + 1}/${MAX_DETAIL_TRIES}): ${e.message}`);
      }
      tries++;
    }
    p.full_text = full;
    p.raw = { article: t.article || null, text: t.text || null, note_tweet: t.note_tweet || null, detail: detailRaw };
    p._dt = tries;
    const cov = parseCoverage(full);
    if (cov) {
      p.coverage_kind = cov.kind;
      if (cov.coverage) p.coverage = cov.coverage;
      if (cov.sources && cov.sources.length) p.sources = cov.sources;
    }
    const pv = parsePreview(t.article ? (t.article.preview_text || full) : full);
    if (pv.lenses != null) p.lenses = pv.lenses;
    delete p.__src;
  }

  // Download every image into KV and rewrite to relative "img/…" paths.
  const index = new Set(JSON.parse((await env.TWEETS_KV.get(IDX_KEY)) || '[]'));
  const usedNames = new Set();
  const localize = makeLocalizer(env, index, usedNames);

  out.account.avatar = await localize(out.account.avatar);
  for (const p of out.posts) {
    if (Array.isArray(p.media) && p.media.length) {
      p.media = await Promise.all(p.media.map(localize));
    }
  }

  // Prune image blobs no longer referenced, and persist the index.
  for (const name of index) {
    if (!usedNames.has(name)) {
      await env.TWEETS_KV.delete(IMG_PREFIX + name);
      index.delete(name);
    }
  }
  await env.TWEETS_KV.put(IDX_KEY, JSON.stringify([...index]));

  return out;
}

/* Absolutise relative "img/…" media paths to this request's origin, so the page
 * (served from GitHub Pages, a different origin) loads them from the Worker. */
function absolutiseMedia(data, origin) {
  const fix = (v) => (typeof v === 'string' && v.startsWith(IMG_PREFIX)) ? `${origin}/${v}` : v;
  if (data.account) data.account.avatar = fix(data.account.avatar);
  for (const p of (data.posts || [])) {
    if (Array.isArray(p.media)) p.media = p.media.map(fix);
  }
  return data;
}

/* ───────────────────────── Worker entry points ───────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  // Cron Trigger → refresh KV (JSON + images). The reliable scheduled job.
  async scheduled(event, env, ctx) {
    const data = await buildTweetsData(env);
    await env.TWEETS_KV.put(KV_KEY, JSON.stringify(data, null, 2) + '\n');
    console.log(`Refreshed ${KV_KEY} in KV (${data.posts.length} posts).`);
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // ── Image route: serve a stored blob straight from KV ──────────────────
    if (url.pathname.startsWith('/' + IMG_PREFIX)) {
      const name = decodeURIComponent(url.pathname.slice(('/' + IMG_PREFIX).length));
      const { value, metadata } = await env.TWEETS_KV.getWithMetadata(IMG_PREFIX + name, { type: 'arrayBuffer' });
      if (!value) return new Response('Not found', { status: 404, headers: CORS });
      return new Response(value, {
        headers: {
          'Content-Type': (metadata && metadata.ct) || CT_BY_EXT[extFor(name)] || 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable', // hash in name → never stale
          ...CORS,
        },
      });
    }

    // ── JSON route: serve cached tweets.json with absolutised image URLs ────
    const forceRefresh = url.searchParams.get('refresh') === '1';

    let data = null;
    if (!forceRefresh) {
      const cached = await env.TWEETS_KV.get(KV_KEY);
      if (cached) data = JSON.parse(cached);
    }
    if (!data) {
      try {
        data = await buildTweetsData(env);
        ctx.waitUntil(env.TWEETS_KV.put(KV_KEY, JSON.stringify(data, null, 2) + '\n'));
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message || err) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
        });
      }
    }

    absolutiseMedia(data, url.origin);
    return new Response(JSON.stringify(data, null, 2) + '\n', {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...CORS,
      },
    });
  },
};
