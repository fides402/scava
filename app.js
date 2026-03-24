/* ═══════════════════════════════════════════════════════════════════
   SCAVA — Album Discovery Engine v2

   Architecture:
   1. Build TASTE PROFILE from user's library (cached Last.fm tags)
   2. EXPAND from library via Last.fm similar artists (2 hops)
   3. For each candidate album: compute MATCH SCORE against profile
   4. Filter by RARITY level (Discogs community.have + LFM listeners)
   5. Enrich with Discogs full metadata + Deezer + Monochrome/Tidal link
   6. Surface best-scoring unseen record + show probability

   APIs: Last.fm · Discogs · Deezer · Monochrome (Tidal proxy)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── KEYS ───────────────────────────────────────────────────────────
// LFM, Discogs, Deezer are read-only public-API tokens — safe client-side.
// Groq key stays server-side (Vercel env var) — called via /api/score proxy.
const LASTFM_KEY    = 'acd1fbf80c19d2febdf1bf378293eedf';
const DISCOGS_TOKEN = 'fvYYQHvhAEHVshXGPHYtbAWSlTUNQpnNJcBBbYCB';
const LASTFM_BASE   = 'https://ws.audioscrobbler.com/2.0';
const DISCOGS_BASE  = 'https://api.discogs.com';
const DEEZER_BASE   = 'https://api.deezer.com';
const MONO_BASE     = 'https://api.monochrome.tf';
const GROQ_PROXY    = '/api/score';   // Vercel serverless — holds GROQ_API_KEY

// ─── RARITY THRESHOLDS ──────────────────────────────────────────────
const RARITY = {
  1: { label: 'Discovery', maxHave: 3500,  maxListeners: 300000, minHave: 0   },
  2: { label: 'Rare',      maxHave: 500,   maxListeners: 50000,  minHave: 0   },
  3: { label: 'Obscure',   maxHave: 80,    maxListeners: 8000,   minHave: 0   },
};

// ─── STATE ──────────────────────────────────────────────────────────
const S = {
  rarityLevel: 1,
  busy: false,
  seen: new Set(),
  seenCount: 0,
  // Taste profile: tag → weight (built from user's library)
  tasteProfile: {},
  tasteBuilt: false,
  // In-session caches (also written to localStorage)
  tagCache: {},    // artist → [tag strings]
  simCache: {},    // artist → [{name, match}]
  dgCache: {},     // "artist|||album" → Discogs search result
  lfmAlbumCache:{},// "artist|||album" → LFM album info
  groqScoreCache:{},// "artist|||album" → {score, reason}
};

// TTLs (ms)
const TTL = {
  tag:      7  * 24 * 3600e3,   // LFM artist tags: 7 days
  sim:      7  * 24 * 3600e3,   // LFM similar artists: 7 days
  dg:       30 * 24 * 3600e3,   // Discogs search: 30 days
  lfmAlbum: 14 * 24 * 3600e3,   // LFM album info: 14 days
  groq:     30 * 24 * 3600e3,   // Groq scores: 30 days
  taste:    3  * 24 * 3600e3,   // Taste profile: 3 days
};

// ─── CACHE HELPERS ──────────────────────────────────────────────────
// Each cached entry: { ts: Date.now(), data: ... }
function cacheGet(store, key, ttl) {
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { delete store[key]; return null; }
  return entry.data;
}
function cacheSet(store, key, data) {
  store[key] = { ts: Date.now(), data };
}

// ─── PERSIST ────────────────────────────────────────────────────────
function loadState() {
  try {
    const seen      = localStorage.getItem('scava_seen_v2');
    const taste     = localStorage.getItem('scava_taste_v2');
    const tagC      = localStorage.getItem('scava_tagcache_v2');
    const simC      = localStorage.getItem('scava_simcache_v2');
    const dgC       = localStorage.getItem('scava_dgcache_v2');
    const lfmC      = localStorage.getItem('scava_lfmcache_v2');
    const groqC     = localStorage.getItem('scava_groqcache_v2');
    if (seen)   S.seen = new Set(JSON.parse(seen));
    if (taste) {
      const t = JSON.parse(taste);
      // Respect taste TTL
      if (Date.now() - (t._ts || 0) < TTL.taste) {
        S.tasteProfile = t.profile || t;
        S.tasteBuilt   = Object.keys(S.tasteProfile).length > 0;
      }
    }
    if (tagC)  S.tagCache      = JSON.parse(tagC);
    if (simC)  S.simCache      = JSON.parse(simC);
    if (dgC)   S.dgCache       = JSON.parse(dgC);
    if (lfmC)  S.lfmAlbumCache = JSON.parse(lfmC);
    if (groqC) S.groqScoreCache= JSON.parse(groqC);
    S.seenCount = S.seen.size;
  } catch (_) {}
}

function saveState() {
  try {
    localStorage.setItem('scava_seen_v2',     JSON.stringify([...S.seen]));
    localStorage.setItem('scava_taste_v2',    JSON.stringify({ _ts: Date.now(), profile: S.tasteProfile }));
    localStorage.setItem('scava_tagcache_v2', JSON.stringify(S.tagCache));
    localStorage.setItem('scava_simcache_v2', JSON.stringify(S.simCache));
    localStorage.setItem('scava_dgcache_v2',  JSON.stringify(S.dgCache));
    localStorage.setItem('scava_lfmcache_v2', JSON.stringify(S.lfmAlbumCache));
    localStorage.setItem('scava_groqcache_v2',JSON.stringify(S.groqScoreCache));
  } catch (e) {
    // localStorage might be full — prune least-used caches
    try { localStorage.removeItem('scava_lfmcache_v2'); } catch (_) {}
    try { localStorage.removeItem('scava_dgcache_v2'); } catch (_) {}
  }
}

// ─── DOM ────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $idle    = $('idleState');
const $loading = $('loadingState');
const $error   = $('errorState');
const $card    = $('resultCard');
const $btn     = $('discoverBtn');
const $counter = $('seenCounter');

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setLoading(msg) {
  hide($idle); hide($error); hide($card);
  show($loading);
  $('loadingText').textContent = msg || 'Searching…';
}
function setError(msg) {
  hide($idle); hide($loading); hide($card);
  show($error);
  $('errorText').textContent = msg || 'Something went wrong. Try again.';
}
function updateCounter() {
  $counter.textContent = S.seenCount > 0 ? `${S.seenCount} record${S.seenCount === 1 ? '' : 's'} discovered` : '';
}

// ─── FETCH ──────────────────────────────────────────────────────────
async function apiFetch(url, timeout = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    return r.json();
  } catch (_) {
    clearTimeout(tid);
    return null;
  }
}

// ─── LAST.FM ────────────────────────────────────────────────────────
async function lfmArtistTags(artist) {
  const key = normalise(artist);
  const cached = cacheGet(S.tagCache, key, TTL.tag);
  if (cached) return cached;
  const url = `${LASTFM_BASE}/?method=artist.gettoptags&artist=${enc(artist)}&api_key=${LASTFM_KEY}&format=json&autocorrect=1`;
  const d = await apiFetch(url);
  const tags = (d?.toptags?.tag || []).slice(0, 12).map(t => normalise(t.name));
  cacheSet(S.tagCache, key, tags);
  return tags;
}

async function lfmSimilarArtists(artist, limit = 30) {
  const key = normalise(artist);
  const cached = cacheGet(S.simCache, key, TTL.sim);
  if (cached) return cached;
  const url = `${LASTFM_BASE}/?method=artist.getsimilar&artist=${enc(artist)}&api_key=${LASTFM_KEY}&format=json&limit=${limit}&autocorrect=1`;
  const d = await apiFetch(url);
  const list = (d?.similarartists?.artist || []).map(a => ({
    name:  a.name,
    match: parseFloat(a.match || '0'),
  }));
  cacheSet(S.simCache, key, list);
  return list;
}

async function lfmTopAlbums(artist, limit = 10) {
  // Top albums are stable — reuse sim cache slot with different key prefix
  const key = `top|${normalise(artist)}`;
  const cached = cacheGet(S.tagCache, key, TTL.sim);
  if (cached) return cached;
  const url = `${LASTFM_BASE}/?method=artist.gettopalbums&artist=${enc(artist)}&api_key=${LASTFM_KEY}&format=json&limit=${limit}&autocorrect=1`;
  const d = await apiFetch(url);
  const result = d?.topalbums?.album || [];
  cacheSet(S.tagCache, key, result);
  return result;
}

async function lfmAlbumInfo(artist, album) {
  const key = normalise(`${artist}|||${album}`);
  const cached = cacheGet(S.lfmAlbumCache, key, TTL.lfmAlbum);
  if (cached !== null) return cached;
  const url = `${LASTFM_BASE}/?method=album.getinfo&artist=${enc(artist)}&album=${enc(album)}&api_key=${LASTFM_KEY}&format=json&autocorrect=1`;
  const d = await apiFetch(url);
  const result = d?.album || null;
  cacheSet(S.lfmAlbumCache, key, result);
  return result;
}

// ─── TASTE PROFILE BUILDER ──────────────────────────────────────────
// Builds a weighted tag vector from the user's known artists.
// Called once per session (result cached in localStorage).
async function buildTasteProfile() {
  if (S.tasteBuilt) return;
  setLoading('Building taste profile…');

  // Sample up to 30 seed artists (favouring shorter, cleaner names)
  const sample = SEED_ARTISTS
    .filter(a => a.length < 40 && !/[&,/]/.test(a.slice(3)))
    .sort(() => Math.random() - 0.5)
    .slice(0, 30);

  const profile = {};
  for (const artist of sample) {
    const tags = await lfmArtistTags(artist);
    for (const tag of tags) {
      profile[tag] = (profile[tag] || 0) + 1;
    }
  }

  // Normalise to [0, 1]
  const max = Math.max(...Object.values(profile), 1);
  for (const k of Object.keys(profile)) profile[k] /= max;

  S.tasteProfile = profile;
  S.tasteBuilt   = true;
  saveState();
}

// ─── GROQ — LLM SCORING ─────────────────────────────────────────────
// Receives ALL collected metadata for each candidate (Last.fm tags,
// Discogs genres/styles, listener counts, year, artist similarity score)
// and uses llama-3.3-70b to reason about fit probability.
// Returns [{i, score, reason}] — score 40–92 integer.
async function groqScoreBatch(candidates) {
  // Taste brief: top tags + sample artists
  const topTags = Object.entries(S.tasteProfile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([t]) => t);

  const sampleArtists = SEED_ARTISTS
    .filter(a => a.length < 35 && !/[&,]/.test(a.slice(3)))
    .sort(() => Math.random() - 0.5)
    .slice(0, 18)
    .join(', ');

  const tasteBrief = `Taste profile — genres/moods/tags: ${topTags.join(', ')}.\nKnown artists (sample): ${sampleArtists}.`;

  // Rich candidate list: all metadata available at this point
  const candidateList = candidates.map((c, i) => {
    const meta = [
      c.albumTags?.length  ? `tags: ${c.albumTags.slice(0, 8).join(', ')}` : null,
      c.discogsStyles?.length ? `styles: ${c.discogsStyles.slice(0, 5).join(', ')}` : null,
      c.year               ? `year: ${c.year}` : null,
      c.label              ? `label: ${c.label}` : null,
      c.listeners          ? `LFM listeners: ${fmtListeners(c.listeners)}` : null,
      c.have !== undefined ? `Discogs owners: ${c.have || 'not listed'}` : null,
      c.sim                ? `artist-sim: ${(c.sim * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join(' | ');
    return `${i + 1}. "${c.album}" — ${c.artist}${meta ? '\n   ' + meta : ''}`;
  }).join('\n');

  const prompt = `You are an expert music curator. Rate how well each album fits this listener.

${tasteBrief}

Score each on 40–92 (integer). Guide: 40=unlikely, 55=weak, 65=decent, 75=good, 85+=excellent.
For scores ≥65 write a single crisp reason (≤12 words, no filler words like "this album").

Candidate albums:
${candidateList}

Return ONLY a JSON object with key "scores" containing an array:
{"scores":[{"i":1,"score":78,"reason":"Spiritual jazz with Brazilian percussion, fits perfectly"},...]}`;

  try {
    const resp = await fetch(GROQ_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.25,
        max_tokens:  700,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) throw new Error(`Groq ${resp.status}`);
    const d = await resp.json();
    const raw = d.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return []; }
    // Tolerate various shapes
    const arr = Array.isArray(parsed)         ? parsed
      : Array.isArray(parsed.scores)          ? parsed.scores
      : Array.isArray(parsed.albums)          ? parsed.albums
      : Array.isArray(parsed.results)         ? parsed.results
      : Object.values(parsed).find(v => Array.isArray(v)) || [];
    return arr;
  } catch (e) {
    console.warn('Groq scoring failed, falling back to tag-overlap:', e.message);
    return [];
  }
}

// ─── MATCH SCORE (fallback, no Groq) ────────────────────────────────
function computeMatchScoreFallback(artistSimilarity, albumTags) {
  let tagScore = 0, tagCount = 0;
  for (const t of albumTags) {
    tagScore += S.tasteProfile[normalise(t)] || 0;
    tagCount++;
  }
  const normTag  = tagCount > 0 ? tagScore / tagCount : 0;
  const simScore = Math.min(1, artistSimilarity || 0);
  const raw = 0.60 * normTag + 0.40 * simScore;
  const pct = 42 + 49 * (1 - Math.exp(-2.8 * raw));
  return Math.round(Math.min(92, Math.max(42, pct)));
}

// ─── DISCOGS ────────────────────────────────────────────────────────
async function discogsSearch(artist, album) {
  const key = normalise(`${artist}|||${album}`);
  const cached = cacheGet(S.dgCache, key, TTL.dg);
  if (cached !== null) return cached;

  const q   = `${artist} ${album}`.trim();
  const url = `${DISCOGS_BASE}/database/search?q=${enc(q)}&type=master&token=${DISCOGS_TOKEN}&per_page=5`;
  const d   = await apiFetch(url);
  if (d?.results?.length) {
    const result = { ...d.results[0], _type: 'master' };
    cacheSet(S.dgCache, key, result);
    return result;
  }
  // Fallback: release search
  const url2 = `${DISCOGS_BASE}/database/search?artist=${enc(artist)}&release_title=${enc(album)}&type=release&token=${DISCOGS_TOKEN}&per_page=5`;
  const d2   = await apiFetch(url2);
  const result = d2?.results?.length ? { ...d2.results[0], _type: 'release' } : null;
  cacheSet(S.dgCache, key, result);
  return result;
}

async function discogsRelease(id, isMaster) {
  const key = `rel|${id}`;
  const cached = cacheGet(S.dgCache, key, TTL.dg);
  if (cached !== null) return cached;
  const path = isMaster ? 'masters' : 'releases';
  const result = await apiFetch(`${DISCOGS_BASE}/${path}/${id}?token=${DISCOGS_TOKEN}`);
  cacheSet(S.dgCache, key, result);
  return result;
}

// ─── DEEZER ─────────────────────────────────────────────────────────
async function deezerSearch(artist, album) {
  const q   = `${artist} ${album}`;
  const url = `${DEEZER_BASE}/search/album?q=${enc(q)}&limit=5`;
  const d   = await apiFetch(url);
  if (!d?.data?.length) return null;
  // Pick closest match
  const norm = normalise;
  return d.data.find(a =>
    norm(a.artist?.name || '') === norm(artist)
  ) || d.data[0];
}

// ─── MONOCHROME / TIDAL ─────────────────────────────────────────────
// Token-overlap similarity — tolerates "(Remastered)", subtitles, etc.
// Returns 0–1.
function albumSim(a, b) {
  const tokenise = s => new Set(normalise(s).split(/\s+/).filter(t => t.length > 1));
  const ta = tokenise(a), tb = tokenise(b);
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.min(ta.size, tb.size);  // precision toward shorter title
}

async function findTidalAlbumId(artist, album) {
  try {
    const tArtist = normalise(artist);
    const tAlbum  = normalise(album);

    // ── Search 1: "artist album" ─────────────────────────────────────
    const q1 = `${artist} ${album}`.trim();
    const d1 = await apiFetch(`${MONO_BASE}/search/?s=${enc(q1)}`, 7000);
    const items1 = d1?.data?.items || [];

    // ── Search 2: just "album" (catches cases where artist is unusual) ─
    const d2 = await apiFetch(`${MONO_BASE}/search/?s=${enc(album)}`, 7000);
    const items2 = d2?.data?.items || [];

    const all = [...items1, ...items2];
    if (!all.length) return null;

    // Deduplicate by track ID
    const seen = new Set();
    const items = all.filter(i => {
      const id = i.id || i.tidalId;
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    });

    // ── Pass 1: check if search results contain inline album info ────
    // Tidal results often have item.album.{id, title} already set.
    for (const item of items) {
      const itemArtist = normalise(item.artist?.name || item.artistName || '');
      if (itemArtist && itemArtist !== tArtist) continue; // skip wrong artist

      const inlineTitle = item.album?.title || item.albumTitle || '';
      const inlineId    = item.album?.id    || item.albumId;
      if (inlineId && inlineTitle && albumSim(inlineTitle, album) >= 0.6) {
        return inlineId;
      }
    }

    // ── Pass 2: call /info/ for up to 5 artist-matching tracks ───────
    // Only pay the extra round-trip when inline album data was absent/wrong.
    const artistCandidates = items
      .filter(i => normalise(i.artist?.name || i.artistName || '') === tArtist)
      .slice(0, 5);

    // If no artist match, fall back to top-5 overall
    const pool = artistCandidates.length ? artistCandidates : items.slice(0, 5);

    let bestId    = null;
    let bestScore = 0;

    for (const item of pool) {
      const trackId = item.id || item.tidalId;
      if (!trackId) continue;

      const info = await apiFetch(`${MONO_BASE}/info/?id=${trackId}`, 7000);
      const infoAlbumTitle = info?.data?.album?.title || '';
      const infoAlbumId    = info?.data?.album?.id || info?.data?.albumId;
      if (!infoAlbumId) continue;

      const score = albumSim(infoAlbumTitle, album);
      if (score > bestScore) {
        bestScore = score;
        bestId    = infoAlbumId;
      }
      // Strong match — stop early
      if (score >= 0.85) break;
    }

    // Only return if we found a reasonably good match (avoid wrong albums)
    return bestScore >= 0.5 ? bestId : null;
  } catch (_) { return null; }
}

// ─── UTILS ──────────────────────────────────────────────────────────
function enc(s)     { return encodeURIComponent(s); }
function normalise(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isKnown(artist, album) {
  const key = `${artist}|||${album}`;
  if (KNOWN_PAIRS.has(key)) return true;
  const na = normalise(artist), nb = normalise(album);
  for (const p of KNOWN_PAIRS) {
    const [a, b] = p.split('|||');
    if (normalise(a) === na && normalise(b) === nb) return true;
  }
  return false;
}

function isSeen(artist, album) {
  const k = `${artist}|||${album}`;
  if (S.seen.has(k)) return true;
  const nk = normalise(k);
  for (const s of S.seen) {
    if (normalise(s) === nk) return true;
  }
  return false;
}

function markSeen(artist, album) {
  S.seen.add(`${artist}|||${album}`);
  S.seenCount = S.seen.size;
  saveState();
}

function pickSeedArtist() {
  const arr = SEED_ARTISTS.filter(a => a.length < 40 && a.trim().length > 1);
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtHave(n) {
  if (!n) return '—';
  if (n >= 1000) return `${(n/1000).toFixed(1)}k`;
  return String(n);
}

function fmtListeners(n) {
  if (!n) return '—';
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(0)}k`;
  return String(n);
}

// ─── MAIN ENGINE ────────────────────────────────────────────────────
async function recommend() {
  if (S.busy) return;
  S.busy = true;
  $btn.disabled = true;

  try {
    // Build taste profile on first run
    if (!S.tasteBuilt) await buildTasteProfile();

    const result = await runEngine();
    if (!result) {
      setError('No results found at this rarity level. Try a different level or hit Discover again.');
    } else {
      renderCard(result);
    }
  } catch (e) {
    console.error(e);
    setError('Network error. Check your connection and try again.');
  } finally {
    S.busy = false;
    $btn.disabled = false;
    updateCounter();
  }
}

// ─── ENGINE ─────────────────────────────────────────────────────────
async function runEngine() {
  const rarity = RARITY[S.rarityLevel];

  // ── PHASE 1: EXPAND — collect candidate (artist, album, sim) tuples ──
  // Strategy:
  //   Hop 1: seed → similar[0..N]         (direct neighbours)
  //   Hop 2: random similar → similar[0..M] (frontier expansion)
  // This discovers artists far from the user's library.

  const candidates = [];     // { artist, album, sim, lfmUrl }
  const seenArtists = new Set(SEED_ARTISTS.map(normalise));

  const addCandidates = async (artistName, simScore) => {
    const albums = await lfmTopAlbums(artistName, 10);
    for (const al of albums) {
      const name = al.name;
      if (!name || name === '(null)') continue;
      if (isKnown(artistName, name)) continue;
      if (isSeen(artistName, name)) continue;
      candidates.push({ artist: artistName, album: name, sim: simScore });
    }
  };

  const MAX_SEEDS   = 4;   // seed artists to start from
  const HOP1_LIMIT  = 12;  // similar artists per seed (hop 1)
  const HOP2_LIMIT  = 6;   // similar artists to expand from hop-1 (hop 2)
  const TARGET      = 60;  // stop collecting at this many candidates

  for (let i = 0; i < MAX_SEEDS && candidates.length < TARGET; i++) {
    const seed = pickSeedArtist();
    setLoading(`Exploring from ${seed}…`);

    const hop1 = await lfmSimilarArtists(seed, HOP1_LIMIT);
    if (!hop1.length) continue;

    // Hop 1: direct similar artists
    for (const artist of hop1) {
      if (candidates.length >= TARGET) break;
      const an = normalise(artist.name);
      if (seenArtists.has(an)) continue;
      seenArtists.add(an);
      await addCandidates(artist.name, artist.match);
    }

    // Hop 2: pick a few hop-1 artists and expand further
    const frontier = hop1
      .filter(a => a.match > 0.3)
      .sort(() => Math.random() - 0.5)
      .slice(0, HOP2_LIMIT);

    for (const f of frontier) {
      if (candidates.length >= TARGET) break;
      setLoading(`Digging deeper via ${f.name}…`);
      const hop2 = await lfmSimilarArtists(f.name, 10);
      for (const artist2 of hop2) {
        if (candidates.length >= TARGET) break;
        const an2 = normalise(artist2.name);
        if (seenArtists.has(an2)) continue;
        seenArtists.add(an2);
        // Hop-2 similarity is discounted
        await addCandidates(artist2.name, artist2.match * f.match);
      }
    }
  }

  if (!candidates.length) return null;

  // ── PHASE 2: PRE-ENRICH — get Last.fm tags + Discogs basic metadata ──
  // We collect everything BEFORE scoring so Groq has full context.
  setLoading('Collecting metadata…');

  const enriched = [];
  const batch = candidates.sort(() => Math.random() - 0.5).slice(0, 18);

  await Promise.all(batch.map(async c => {
    // Last.fm album info (tags, listeners)
    const info       = await lfmAlbumInfo(c.artist, c.album);
    const listeners  = parseInt(info?.listeners || '0', 10);
    const albumTags  = (info?.tags?.tag || []).map(t => normalise(t.name));
    const artistTags = await lfmArtistTags(c.artist);
    const allTags    = [...new Set([...albumTags, ...artistTags])];

    // Light Discogs search (just for have + styles — no full release fetch yet)
    const dg    = await discogsSearch(c.artist, c.album);
    const have  = dg?.community?.have || 0;
    const discogsStyles = [
      ...(dg?.style || []),
      ...(dg?.genre || []),
    ].slice(0, 6);

    // Year from Discogs or LFM
    const year  = dg?.year || dg?.master_year || info?.releasedate?.trim().slice(0, 4) || '';
    const label = (dg?.label?.[0] || '').replace(/\s*\([^)]*\)/g, '').trim();

    // Rarity pre-filter (fast reject before sending to Groq)
    if (S.rarityLevel === 1 && listeners > 500000) return;
    if (S.rarityLevel >= 2 && listeners > 0 && listeners > rarity.maxListeners) return;
    if (S.rarityLevel >= 2 && dg && have > rarity.maxHave) return;

    // Fallback score used if Groq fails
    const fallbackScore = computeMatchScoreFallback(c.sim, allTags);

    enriched.push({
      ...c,
      listeners, albumTags: allTags, discogsStyles,
      year, label,
      have, dgResult: dg,
      matchScore: fallbackScore,
      reason: '',
      lfmInfo: info,
    });
  }));

  if (!enriched.length) return null;

  // ── PHASE 3: GROQ SCORING — send ALL metadata, get probabilities ──
  // Check cache first; only send uncached candidates to Groq
  const uncached = enriched.filter(c => {
    const k = normalise(`${c.artist}|||${c.album}`);
    const hit = cacheGet(S.groqScoreCache, k, TTL.groq);
    if (hit) {
      c.matchScore = hit.score;
      c.reason     = hit.reason || '';
      return false;
    }
    return true;
  });

  if (uncached.length > 0) {
    setLoading('AI scoring candidates…');
    const groqResults = await groqScoreBatch(uncached);
    for (const g of groqResults) {
      const idx = (g.i || 0) - 1;
      if (idx >= 0 && idx < uncached.length) {
        const c = uncached[idx];
        if (typeof g.score === 'number' && g.score >= 40) {
          c.matchScore = Math.round(Math.min(92, g.score));
        }
        if (g.reason) c.reason = g.reason;
        // Persist this score
        const k = normalise(`${c.artist}|||${c.album}`);
        cacheSet(S.groqScoreCache, k, { score: c.matchScore, reason: c.reason });
      }
    }
  }

  // Sort by AI-assigned match score
  enriched.sort((a, b) => b.matchScore - a.matchScore);
  // Persist all caches after scoring pass
  saveState();

  // ── PHASE 4: FULL ENRICH — pick the top-scored & get complete data ──
  for (const c of enriched.slice(0, 6)) {
    setLoading(`Fetching details for "${c.album}"…`);

    const dg   = c.dgResult;
    const have = c.have;

    // Rarity gate (final, for any slippage)
    if (S.rarityLevel >= 2 && dg && have > rarity.maxHave) continue;

    // Full Discogs release (labels, hi-res styles)
    let dgFull = null;
    if (dg?.id) {
      dgFull = await discogsRelease(dg.id, dg._type === 'master');
    }

    // Deezer + Monochrome in parallel
    const [deezerAlbum, tidalAlbumId] = await Promise.all([
      deezerSearch(c.artist, c.album),
      findTidalAlbumId(c.artist, c.album),
    ]);

    // Cover: Deezer hi-res > Discogs > Last.fm
    let cover = deezerAlbum?.cover_xl
      || deezerAlbum?.cover_big
      || (dg?.cover_image?.includes('spacer') ? '' : dg?.cover_image || '')
      || c.lfmInfo?.image?.find?.(img => img.size === 'extralarge')?.['#text']
      || '';
    if (cover?.includes('2a96cbd8b46e442fc41c2b86b821562f')) cover = '';

    // Styles: merge Discogs full + pre-collected
    const styles = [
      ...(dgFull?.styles || []),
      ...(dgFull?.genres || []),
      ...c.discogsStyles,
    ].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 6);

    const tags = [...new Set([
      ...c.albumTags,
      ...styles.map(s => s.toLowerCase()),
    ])].slice(0, 6);

    const year  = dgFull?.year || c.year || '—';
    const label = (dgFull?.labels?.[0]?.name || c.label || '')
      .replace(/\s*\([^)]*\)/g, '').trim();

    const discogsUrl = dg?.id
      ? `https://www.discogs.com/${dg._type === 'master' ? 'master' : 'release'}/${dg.id}`
      : `https://www.discogs.com/search/?q=${enc(c.artist + ' ' + c.album)}&type=release`;

    markSeen(c.artist, c.album);

    return {
      artist:     c.artist,
      album:      c.album,
      year, label, tags, cover,
      have,
      listeners:  c.listeners,
      matchScore: c.matchScore,
      reason:     c.reason,
      discogsUrl,
      deezerUrl:  deezerAlbum?.link || null,
      monoUrl:    tidalAlbumId ? `https://monochrome.tf/album/${tidalAlbumId}` : null,
      rarityLevel: S.rarityLevel,
    };
  }

  return null;
}

// ─── RENDER ─────────────────────────────────────────────────────────
function renderCard(r) {
  hide($idle); hide($loading); hide($error);

  // Art
  const artEl = $('cardArt');
  artEl.style.display = '';
  if (r.cover) {
    artEl.src   = r.cover;
    artEl.alt   = `${r.artist} — ${r.album}`;
    artEl.onerror = () => { artEl.style.display = 'none'; };
  } else {
    artEl.style.display = 'none';
  }

  // Rarity badge
  const badge = $('rarityBadge');
  badge.dataset.level = r.rarityLevel;
  badge.textContent   = RARITY[r.rarityLevel].label;

  // Meta
  $('cardYear').textContent   = r.year;
  $('cardLabel').textContent  = r.label;
  $('cardAlbum').textContent  = r.album;
  $('cardArtist').textContent = r.artist;

  // Tags
  const tagsEl = $('cardTags');
  tagsEl.innerHTML = r.tags.length
    ? r.tags.map(t => `<span class="tag">${t}</span>`).join('')
    : '';

  // Stats
  const statsEl = $('cardStats');
  statsEl.innerHTML = `
    <div class="stat">
      <span class="stat-label">Match</span>
      <span class="stat-value match-value" data-score="${r.matchScore}">${r.matchScore}%</span>
    </div>
    ${r.have > 0 ? `
    <div class="stat">
      <span class="stat-label">Discogs owners</span>
      <span class="stat-value">${fmtHave(r.have)}</span>
    </div>` : ''}
    ${r.listeners > 0 ? `
    <div class="stat">
      <span class="stat-label">Last.fm listeners</span>
      <span class="stat-value">${fmtListeners(r.listeners)}</span>
    </div>` : ''}`;

  // Colour-code the match score
  const matchEl = statsEl.querySelector('.match-value');
  if (matchEl) {
    const sc = r.matchScore;
    matchEl.style.color = sc >= 78 ? '#7AE090'
      : sc >= 64 ? '#B0D87A'
      : sc >= 52 ? '#F5C842'
      : '#9B9B9B';
  }

  // Why — Groq reason takes priority, then rarity context
  const whyEl = $('cardWhy');
  whyEl.textContent = '';
  if (r.reason) {
    whyEl.textContent = r.reason;
  } else if (r.rarityLevel === 3 && r.have > 0) {
    whyEl.textContent = `Only ${fmtHave(r.have)} copies tracked on Discogs — a genuine hidden gem.`;
  } else if (r.rarityLevel === 3) {
    whyEl.textContent = 'No Discogs trace — this one is seriously under the radar.';
  } else if (r.rarityLevel === 2) {
    whyEl.textContent = `${fmtHave(r.have)} Discogs owners · ${fmtListeners(r.listeners)} Last.fm listeners.`;
  }

  // Links
  const linksEl = $('cardLinks');
  linksEl.innerHTML = `
    <a class="link-btn" href="${r.discogsUrl}" target="_blank" rel="noopener">
      ${svgDiscogs()} Discogs
    </a>`;

  if (r.monoUrl) {
    linksEl.innerHTML += `
      <a class="link-btn" href="${r.monoUrl}" target="_blank" rel="noopener">
        ${svgMono()} Monochrome
      </a>`;
  }

  if (r.deezerUrl) {
    linksEl.innerHTML += `
      <a class="link-btn" href="${r.deezerUrl}" target="_blank" rel="noopener">
        ${svgDeezer()} Deezer
      </a>`;
  }

  show($card);
}

// ─── ICONS ──────────────────────────────────────────────────────────
function svgDiscogs() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function svgMono() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}
function svgDeezer() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="4" height="18" rx="1"/><rect x="8" y="7" width="4" height="14" rx="1"/><rect x="14" y="10" width="4" height="11" rx="1"/><rect x="20" y="13" width="2" height="8" rx="1"/></svg>`;
}

// ─── RARITY SELECTOR ────────────────────────────────────────────────
document.querySelectorAll('.rarity-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rarity-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.rarityLevel = parseInt(btn.dataset.level, 10);
  });
});

// ─── DISCOVER BUTTON ────────────────────────────────────────────────
$btn.addEventListener('click', recommend);

// ─── INIT ────────────────────────────────────────────────────────────
loadState();
updateCounter();
