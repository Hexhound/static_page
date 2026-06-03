#!/usr/bin/env node
/**
 * Olhar Factual — X → tweets.json fetcher  (RapidAPI: twitter-api45)
 * ----------------------------------------------------------------------------
 * Pulls the latest posts for your handle from the "twitter-api45" RapidAPI
 * endpoint and writes them into tweets.json in the shape that
 * "index.html" expects. No official X API / $200 tier needed.
 *
 * Free plan = 1000 requests/month. One timeline call ≈ 1 request and returns
 * ~20 posts, so an HOURLY refresh (~720/mo) stays comfortably under the cap.
 *
 * Requires (env vars / GitHub secrets):
 *   RAPIDAPI_KEY   — your RapidAPI key (Settings → keep it SECRET, never in the page)
 *
 * Optional env:
 *   X_HANDLE       — account screen name without @ (default: olharfactual)
 *   OUT_PATH       — where to write JSON (default: tweets.json)
 *   MAX_POSTS      — cap how many posts to keep (default: 20)
 *
 * Run:  RAPIDAPI_KEY=xxxx node x-fetcher/fetch.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';
const HANDLE        = process.env.X_HANDLE || 'olharfactual';
const OUT_PATH      = process.env.OUT_PATH || 'tweets.json';
const MAX_POSTS     = Math.max(1, parseInt(process.env.MAX_POSTS || '20', 10));

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
function parseCoverage(rawText) {
  try {
    if (!rawText) return null;
    const text = normalizeBold(rawText);
    const flat = stripAccents(text);
    let kind = null;
    if (/COBERTURA ASSIM/i.test(flat)) kind = 'blindspot';
    else if (/A MESMA NOTICIA/i.test(flat)) kind = 'comparison';
    const sides = {};
    const re = /(Esquerda|Centro|Direita)\s*:\s*(\d+)\s*artigo\(s\)(?:\s*de\s*(\d+)\s*outlet\(s\))?\s*(?:[—–-]\s*([^\n]+))?/gi;
    let m, found = false;
    while ((m = re.exec(text))) {
      found = true;
      const key = SIDE_KEY[stripAccents(m[1]).toUpperCase()];
      const count = parseInt(m[2], 10) || 0;
      let outlets = [];
      const tail = (m[4] || '').trim();
      if (tail && !/nenhum outlet/i.test(tail)) outlets = tail.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      sides[key] = { count, outlets };
    }
    const sources = parseSources(text);
    if (!found) return kind ? { kind, coverage: null, sources } : null;
    for (const k of ['left', 'center', 'right']) if (!sides[k]) sides[k] = { count: 0, outlets: [] };
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
      ...base, title: text, summary: '', lenses: null, media, media_alt: alt,
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

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Wrote ${posts.length} posts → ${OUT_PATH}`);
