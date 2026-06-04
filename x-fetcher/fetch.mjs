#!/usr/bin/env node
/**
 * Olhar Factual — X → tweets.json fetcher  (RapidAPI: twitter-api45)
 * ----------------------------------------------------------------------------
 * Pulls the latest posts for your handle from the "twitter-api45" RapidAPI
 * endpoint and writes them into tweets.json in the shape that
 * "Feed do X.html" expects. No official X API / $200 tier needed.
 *
 * Free plan = 1000 requests/month. One timeline call ≈ 1 request and returns
 * ~20 posts, so an HOURLY refresh (~720/mo) stays comfortably under the cap.
 *
 * Requires (env vars / GitHub secrets):
 *   RAPIDAPI_KEY   — your RapidAPI key (Settings → keep it SECRET, never in the page)
 *
 * Optional env:
 *   X_HANDLE       — account screen name without @ (default: olharfactual)
 *   OUT_PATH       — where to write JSON (default: olhar-factual/tweets.json)
 *   MAX_POSTS      — cap how many posts to keep (default: 20)
 *   MEDIA_DIR      — where to save downloaded images
 *                    (default: <dir of OUT_PATH>/media — i.e. next to tweets.json)
 *   MEDIA_PUBLIC   — URL prefix written INTO the JSON for each image
 *                    (default: 'media' — a relative path the page resolves itself)
 *   NO_MEDIA=1     — skip downloading; keep the original X CDN urls (old behavior)
 *
 * Images: by default every cover/avatar is downloaded into MEDIA_DIR and the JSON
 * is rewritten to point at the LOCAL copy, so the site serves images from its own
 * origin (the repo) instead of hotlinking pbs.twimg.com — which throttles/breaks.
 * Filenames are a hash of the source url, so re-runs reuse files and git stays quiet.
 *
 * Run:  RAPIDAPI_KEY=xxxx node x-fetcher/fetch.mjs
 */

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';
const HANDLE        = process.env.X_HANDLE || 'olharfactual';
const OUT_PATH      = process.env.OUT_PATH || 'olhar-factual/tweets.json';
const MAX_POSTS     = Math.max(1, parseInt(process.env.MAX_POSTS || '20', 10));
const MEDIA_DIR     = process.env.MEDIA_DIR || join(dirname(OUT_PATH), 'media');
const MEDIA_PUBLIC  = (process.env.MEDIA_PUBLIC ?? 'media').replace(/\/+$/, '');
const NO_MEDIA      = process.env.NO_MEDIA === '1';
// Per-tweet detail fetch to recover the FULL article body (the timeline only gives
// a truncated preview_text, so the "Dados da cobertura" block is missing → bias bar
// stays empty). Best-effort, cached, and budgeted so it can't blow the free cap.
const FETCH_DETAIL  = process.env.FETCH_DETAIL !== '0';                       // default ON
const DETAIL_BUDGET = Math.max(0, parseInt(process.env.DETAIL_BUDGET || '15', 10)); // calls/run

if (!RAPIDAPI_KEY) {
  console.error('Missing RAPIDAPI_KEY environment variable.');
  process.exit(1);
}

const url = `https://${RAPIDAPI_HOST}/timeline.php?screenname=${encodeURIComponent(HANDLE)}`;
const res = await fetch(url, {
  headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
});

if (!res.ok) {
  console.error(`RapidAPI error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
const timeline = Array.isArray(data.timeline) ? data.timeline : [];
if (!timeline.length) {
  console.error('No tweets returned. Raw response keys:', Object.keys(data));
  // Still write an (empty) file so the page shows its friendly empty state.
}

// Reuse the previous tweets.json as a cache: full bodies we already fetched (and
// detail-fetch attempts we already made) are kept, so each run only spends API
// quota on genuinely NEW posts. First run has no cache — that's fine.
let prevById = new Map();
try {
  const prev = JSON.parse(await readFile(OUT_PATH, 'utf8'));
  for (const p of (prev.posts || [])) prevById.set(String(p.id), p);
} catch { /* no previous file yet */ }

/* ----- helpers to read fields defensively (schema varies slightly) ----- */
function num(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toISO(created_at) {
  if (!created_at) return undefined;
  const d = new Date(created_at);              // handles "Wed Jun 03 11:15:00 +0000 2026"
  return isNaN(d) ? undefined : d.toISOString();
}

function bigAvatar(u) { return u ? u.replace('_normal.', '_400x400.') : u; }

/* ----- image localizer ------------------------------------------------------
 * Downloads a remote image into MEDIA_DIR and returns the LOCAL path to write
 * into the JSON (e.g. "media/ab12cd34.jpg"). The page then loads it from its
 * own origin instead of hotlinking pbs.twimg.com (which throttles → flaky images).
 *
 * - Filename is a sha1 of the source URL → stable across runs, so an unchanged
 *   image is NOT re-downloaded and git sees no churn.
 * - For pbs.twimg.com we request the large rendition for crisp covers.
 * - Any failure falls back to the original remote URL — never breaks the build.
 * --------------------------------------------------------------------------*/
const localized = new Map();   // url -> local path, dedupe within a run
let existing = null;           // Set of filenames already on disk

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

async function localizeImage(url) {
  if (NO_MEDIA || !url || !/^https?:\/\//i.test(url)) return url;
  if (localized.has(url)) return localized.get(url);

  const name = createHash('sha1').update(url).digest('hex').slice(0, 16) + extFor(url);
  const publicPath = MEDIA_PUBLIC ? `${MEDIA_PUBLIC}/${name}` : name;

  // Already downloaded in a previous run? reuse it, no network call.
  if (existing === null) {
    try { existing = new Set(await readdir(MEDIA_DIR)); }
    catch { existing = new Set(); }
  }
  if (existing.has(name)) { localized.set(url, publicPath); return publicPath; }

  try {
    // Ask twimg for the large rendition (covers look sharp at hero size).
    let fetchUrl = url;
    if (/pbs\.twimg\.com\/media\//i.test(url) && !/[?&]name=/i.test(url)) {
      fetchUrl += (url.includes('?') ? '&' : '?') + 'name=large';
    }
    const r = await fetch(fetchUrl, { headers: { 'User-Agent': 'olhar-factual-fetcher' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, name), buf);
    existing.add(name);
    localized.set(url, publicPath);
    console.log(`  ↓ image ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    return publicPath;
  } catch (e) {
    console.warn(`  ! image download failed, keeping remote url (${e.message}): ${url}`);
    return url;   // graceful fallback — page still gets a (remote) image
  }
}

/* ----- coverage parser ------------------------------------------------------
 * Extracts the "Dados da cobertura" block (and Fontes list) from an article's
 * text into structured { kind, coverage, sources }. Wrapped in try/catch so a
 * malformed post can never break the build — it just yields null (safe fallback).
 *
 * NOTE: the timeline endpoint returns a TRUNCATED `preview_text`, which usually
 * does NOT include the coverage block — so coverage will be null for most posts
 * unless you feed this the FULL article body (see README "Coverage data").
 * --------------------------------------------------------------------------*/
function normalizeBold(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1D5D4 && c <= 0x1D5ED) out += String.fromCharCode(65 + (c - 0x1D5D4));      // 𝗔-𝗭
    else if (c >= 0x1D5EE && c <= 0x1D607) out += String.fromCharCode(97 + (c - 0x1D5EE));  // 𝗮-𝘇
    else if (c >= 0x1D7EC && c <= 0x1D7F5) out += String.fromCharCode(48 + (c - 0x1D7EC));  // 𝟬-𝟵
    else out += ch;
  }
  return out;
}
const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const LEAN_BY_EMOJI = { '🔴': 'left', '🔵': 'left', '⚪': 'center', '⚫': 'center', '🟢': 'right' };
const SIDE_KEY = { ESQUERDA: 'left', CENTRO: 'center', DIREITA: 'right' };
const cleanOutlet = (s) => String(s).replace(/^[\s🔴🔵⚪⚫🟢•·*]+/, '').replace(/[•·*]/g, '').trim();

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
const trimOutlet = (s) => cleanOutlet(s).replace(/\s+\d+$/, ''); // also drop trailing citation number
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

    // Format A — explicit counts: "Esquerda: 8 artigo(s) de 4 outlet(s) — G1, O Globo"
    // (the blindspot/COBERTURA ASSIMÉTRICA posts use this).
    const reA = /(Esquerda|Centro|Direita)\s*:\s*(\d+)\s*artigo\(s\)(?:\s*de\s*(\d+)\s*outlet\(s\))?\s*(?:[—–-]\s*([^\n]+))?/gi;
    while ((m = reA.exec(text))) {
      found = true;
      const key = SIDE_KEY[stripAccents(m[1]).toUpperCase()];
      const tail = (m[4] || '').trim();
      const outlets = (tail && !/nenhum outlet/i.test(tail)) ? tail.split(/[,;]/).map(trimOutlet).filter(Boolean) : [];
      sides[key] = { count: parseInt(m[2], 10) || 0, outlets };
    }

    // Format B — outlets in parentheses: "🔴 Esquerda (Folha, Carta, UOL): …" (the
    // A MESMA NOTÍCIA comparison posts use this — no explicit counts). Count = distinct
    // outlets. Anchored to line-start + optional lean emoji so prose never matches.
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
    return null; // safe fallback — never break the build over one bad post
  }
}

// The account posts X "articles": each has a title, a "🔍 A MESMA NOTÍCIA, DUAS/TRÊS
// LENTES DIFERENTES\n<summary>" preview, and a cover image. Parse those out.
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

// Fallback media collector for plain (non-article) tweets that carry photos.
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

const hasCoverageBlock = (s) => /Dados da cobertura|COBERTURA ASSIM|artigo\(s\)/i.test(normalizeBold(s || ''));

/* ----- full-body enrichment -------------------------------------------------
 * The timeline returns only a truncated `article.preview_text`; the coverage block
 * lives in the full article body. `tweet.php?id=<id>` MAY return richer content —
 * we try it best-effort, store whatever raw payload comes back for inspection, and
 * pick the longest text we can find. If your plan doesn't expose article bodies,
 * `raw.detail` simply shows that and nothing breaks.
 * --------------------------------------------------------------------------*/
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
  if (a) best = longestText(a, best); // scan the article subtree for the richest text
  return best;
}
async function fetchDetail(id) {
  const u = `https://${RAPIDAPI_HOST}/tweet.php?id=${encodeURIComponent(id)}`;
  const r = await fetch(u, { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

const posts = timeline
  // ONLY X Articles — plain tweets/retweets/replies are excluded from this page
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
      // Try to parse coverage from the fullest text we have. preview_text is
      // usually truncated → cov is null → the page falls back to the lens kicker.
      const fullText = t.article.full_text || t.note_tweet?.text || t.article.preview_text || '';
      const cov = parseCoverage(fullText);
      return {
        ...base,
        __src: t,
        title,
        summary,
        lenses,
        media: t.article.cover_media ? [t.article.cover_media] : [],
        media_alt: title,
        coverage_kind: cov ? cov.kind : 'comparison',
        coverage: cov ? cov.coverage : null,
        sources: cov ? cov.sources : [],
      };
    }
    // plain tweet (no article): strip the bare t.co link, use remaining text as title
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

// ── Store the FULL raw payload + best-available body text on every post ───────
// The page re-parses coverage/sources/lenses/summary from `full_text` at RUNTIME,
// so a parser fix takes effect with no re-fetch. We also keep `raw` (the article
// object + any detail response) so you can inspect exactly what the API returns.
//
// Quota control: we only spend a `tweet.php` detail call on a post that (a) still
// lacks the coverage block AND (b) hasn't been attempted before (tracked via the
// cached `_d` flag), capped at DETAIL_BUDGET per run. So steady-state cost ≈ the
// number of NEW posts per day, not 20×/run.
let detailSpent = 0;
for (const p of out.posts) {
  const t = p.__src || {};
  const cached = prevById.get(String(p.id));

  // Start from the timeline text; reuse a richer body we already cached.
  let full = timelineText(t);
  if (cached && typeof cached.full_text === 'string' && cached.full_text.length > full.length) {
    full = cached.full_text;
  }

  // Carry forward a previous detail payload (so we don't lose it on cache reuse).
  let detailRaw = (cached && cached.raw && cached.raw.detail) || null;
  let attempted = !!(cached && cached._d);

  if (FETCH_DETAIL && !hasCoverageBlock(full) && !attempted && detailSpent < DETAIL_BUDGET) {
    try {
      detailSpent++;
      detailRaw = await fetchDetail(p.id);
      const dt = detailText(detailRaw);
      if (dt && dt.length > full.length) full = dt;
      console.log(`  ↳ detail ${p.id} → ${full.length} chars${hasCoverageBlock(full) ? ' (+coverage block)' : ''}`);
    } catch (e) {
      console.warn(`  ! detail fetch failed for ${p.id}: ${e.message}`);
    }
    attempted = true;
  }

  p.full_text = full;
  p.raw = { article: t.article || null, text: t.text || null, note_tweet: t.note_tweet || null, detail: detailRaw };
  p._d = (attempted || hasCoverageBlock(full)) ? 1 : 0;

  // Re-parse with the fullest text we now have (best-effort; the page re-parses too).
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

// Download every image to MEDIA_DIR and rewrite the JSON to local paths, so the
// site serves them from its own origin instead of hotlinking the X CDN.
if (!NO_MEDIA) {
  out.account.avatar = await localizeImage(out.account.avatar);
  for (const p of out.posts) {
    if (Array.isArray(p.media) && p.media.length) {
      p.media = await Promise.all(p.media.map(localizeImage));
    }
  }
}

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Wrote ${posts.length} posts → ${OUT_PATH}`);

// Make it obvious WHERE images went (the #1 source of "I don't see a media dir":
// the folder lives next to OUT_PATH, not necessarily where you're looking).
if (!NO_MEDIA) {
  let count = 0;
  try { count = (await readdir(MEDIA_DIR)).length; } catch { /* none */ }
  console.log(`Images: ${count} file(s) in ${resolve(MEDIA_DIR)}  (JSON refers to them as "${MEDIA_PUBLIC}/…")`);
  if (count === 0) console.log('  ⚠ No images downloaded — every cover fell back to its remote URL (check the warnings above).');
} else {
  console.log('Images: NO_MEDIA=1 set → kept remote X URLs, nothing downloaded.');
}
