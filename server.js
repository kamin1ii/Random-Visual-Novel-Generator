// Node/Express replacement for worker.js, used when the site is hosted directly on the
// VPS instead of Cloudflare Workers. Same routes, same query logic, same response shapes
// as worker.js, just swapped from D1 (async, binding-based) to better-sqlite3 (sync,
// local file) and from the R2 Worker binding to R2's S3-compatible API. worker.js itself
// is left untouched as a rollback path back to Cloudflare Workers/Pages.

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';
const R2_BUCKET = process.env.R2_BUCKET || 'rvng-covers';
const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

// Matches refresh-vndb-db.mjs's imageIdToPath() output exactly, e.g. "cv/39/20339.jpg".
// Without this, /img/* would happily fetch and cache-write whatever path a caller asks
// for, an unauthenticated, unbounded way to make this server copy arbitrary content from
// VNDB into R2 under a key of the caller's choosing.
const COVER_KEY_PATTERN = /^cv\/\d{2}\/\d+\.jpg$/;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// VNDB hosts cover art for its entire catalog, not just the ~65k VNs in this site's own
// filtered dataset, so a key merely matching the right shape isn't enough on its own, it
// still lets someone cache and serve whatever real VNDB image they want under this domain.
// This confirms the key belongs to a VN actually present in the local database before
// anything gets fetched or cached.
const imagePathExistsStmt = db.prepare('SELECT 1 FROM vn WHERE image_path = ? LIMIT 1');
function isKnownCoverKey(key){
  return !!imagePathExistsStmt.get(key);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Caddy is a trusted local reverse proxy in front of this app

// --- Rate limiting for /api/generate, mirrors VNDB's own published API terms: up to 200
// requests per 5 minutes, up to 1 second of measured handler execution time per minute,
// and requests running past 3 seconds get their response aborted. Kept in process (no
// external store) since this is a single Node process. Caveat: because better-sqlite3
// queries run synchronously on the main thread, the 3 second abort can only ever cut off
// the client visible response, it cannot preempt a hung query mid flight, Node has no way
// to interrupt synchronous JS from a timer callback. In practice this endpoint's queries
// are indexed lookups over ~65k rows and finish in single digit milliseconds, so this is
// a safety net for a pathological case, not a normal path concern.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 200;
const COMPUTE_BUDGET_WINDOW_MS = 60 * 1000;
const COMPUTE_BUDGET_MS = 1000;
const REQUEST_TIMEOUT_MS = 3000;

const rateLimitState = new Map(); // ip -> { requestTimestamps: number[], computeMs: number, computeWindowStart: number }

function getClientIp(req){
  // Cloudflare sits in front of Caddy and sets this on every proxied request, overwriting
  // any client supplied value, it's the one IP source here that can't be spoofed by the
  // client itself. Falls back to X-Forwarded-For/socket address for requests that go
  // directly to origin, skipping Cloudflare entirely.
  const cfIp = req.headers['cf-connecting-ip'];
  if(cfIp) return cfIp;
  const xff = req.headers['x-forwarded-for'];
  if(xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function getRateState(ip){
  let state = rateLimitState.get(ip);
  if(!state){
    state = { requestTimestamps: [], computeMs: 0, computeWindowStart: Date.now() };
    rateLimitState.set(ip, state);
  }
  return state;
}

// periodic sweep so the map doesn't grow forever with IPs that have gone quiet
setInterval(() => {
  const now = Date.now();
  for(const [ip, state] of rateLimitState){
    state.requestTimestamps = state.requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if(state.requestTimestamps.length === 0 && now - state.computeWindowStart > COMPUTE_BUDGET_WINDOW_MS){
      rateLimitState.delete(ip);
    }
  }
}, 60 * 1000).unref();

function rateLimitMiddleware(req, res, next){
  const ip = getClientIp(req);
  const now = Date.now();
  const state = getRateState(ip);

  state.requestTimestamps = state.requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if(state.requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS){
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests, slow down.' });
  }

  if(now - state.computeWindowStart >= COMPUTE_BUDGET_WINDOW_MS){
    state.computeWindowStart = now;
    state.computeMs = 0;
  }
  if(state.computeMs >= COMPUTE_BUDGET_MS){
    res.set('Retry-After', '30');
    return res.status(429).json({ error: 'Too many requests, slow down.' });
  }

  state.requestTimestamps.push(now);

  const timeout = setTimeout(() => {
    if(!res.headersSent) res.status(503).json({ error: 'Request timed out' });
  }, REQUEST_TIMEOUT_MS);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    clearTimeout(timeout);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    state.computeMs += elapsedMs;
  });

  next();
}

// Separate, much higher-throughput limiter just for the R2-write (cache miss) path on
// /img/*, a single page load can legitimately request dozens of covers. Cache hits aren't
// limited at all, they're cheap, this only bounds how many NEW objects any one IP can
// cause to be written into R2.
const IMAGE_MISS_WINDOW_MS = 5 * 60 * 1000;
const IMAGE_MISS_MAX = 100; // generous for real browsing, most covers are already cached after the first person loads them
const imageMissState = new Map(); // ip -> timestamps[]

function imageMissAllowed(ip){
  const now = Date.now();
  const timestamps = imageMissState.get(ip) || [];
  const fresh = timestamps.filter(t => now - t < IMAGE_MISS_WINDOW_MS);
  if(fresh.length >= IMAGE_MISS_MAX){
    imageMissState.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  imageMissState.set(ip, fresh);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for(const [ip, timestamps] of imageMissState){
    const fresh = timestamps.filter(t => now - t < IMAGE_MISS_WINDOW_MS);
    if(fresh.length === 0) imageMissState.delete(ip);
    else imageMissState.set(ip, fresh);
  }
}, 60 * 1000).unref();

// Files that live in the repo root but must never be served as static assets, same intent
// as worker.js's .assetsignore. Checked against the first path segment only, since these
// are all root-level files.
const DENY_TOP_LEVEL = new Set([
  'worker.js', 'server.js', 'package.json', 'package-lock.json', 'wrangler.toml',
  '.assetsignore', '.env', '.git', '.wrangler', 'node_modules', 'randomvn-dump.sql',
]);

app.use((req, res, next) => {
  if(req.hostname === 'www.randomvn.org'){
    return res.redirect(301, `https://randomvn.org${req.originalUrl}`);
  }
  next();
});

app.use((req, res, next) => {
  const firstSegment = req.path.split('/')[1];
  if(firstSegment && DENY_TOP_LEVEL.has(firstSegment)){
    return res.status(404).end();
  }
  next();
});

app.get('/img/*', async (req, res) => {
  const key = req.params[0];
  if(!key || !COVER_KEY_PATTERN.test(key) || !isKnownCoverKey(key)){
    return res.status(404).send('Unknown image path');
  }

  try{
    const cached = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.set({
      'Content-Type': cached.ContentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'HIT',
    });
    return cached.Body.pipe(res);
  }catch(err){
    if(err.name !== 'NoSuchKey'){
      console.error('R2 get failed, falling back to upstream:', err.name || err);
    }
  }

  if(!imageMissAllowed(getClientIp(req))){
    return res.status(429).send('Too many uncached image requests, slow down.');
  }

  // the one request per unique image that has to actually reach VNDB
  let upstream;
  try{
    upstream = await fetch(`${VNDB_IMAGE_HOST}/${key}`);
  }catch(err){
    console.error('Upstream fetch errored:', err);
    return res.status(502).send('Upstream fetch failed');
  }
  if(!upstream.ok){
    return res.status(upstream.status).send('Upstream fetch failed');
  }

  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if(!contentType.startsWith('image/')){
    // defense in depth, the key pattern above already makes this practically unreachable
    console.error('Upstream returned a non-image content type, refusing to cache:', contentType);
    return res.status(502).send('Unexpected upstream content type');
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());

  // doesn't block the response on the R2 write, cache just isn't warm for the next request yet
  s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
    .catch(err => console.error('R2 put failed:', err));

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Cache': 'MISS',
  });
  res.send(buffer);
});

function safeJsonParse(val){
  if(!val) return [];
  try{ return JSON.parse(val); }
  catch(err){ return []; }
}

app.get('/api/db-info', (req, res) => {
  try{
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dump_timestamp'").get();
    res.json({ dumpTimestamp: row ? row.value : null });
  }catch(err){
    res.status(500).json({ dumpTimestamp: null, error: 'lookup failed' });
  }
});

// Every WHERE clause is built with real parameterized placeholders (bind, not string
// interpolation), this endpoint handles live public input, unlike the offline import
// script, so this matters here in a way it didn't there.
function buildWhereClause(filters){
  const conditions = ['has_description = 1']; // baseline, matches the site's existing behavior regardless of UI settings
  const params = [];

  const minVotes = parseInt(filters.minVotes, 10) || 0;
  if(minVotes > 0){
    conditions.push('votecount >= ?');
    params.push(minVotes);
  }

  const minRating = parseFloat(filters.minRating) || 0;
  if(minRating > 0){
    // clamped to 10, same fix as the live API version, values below 10 aren't meaningfully distinct
    conditions.push('rating >= ?');
    params.push(Math.max(10, Math.round(minRating * 10)));
  }

  if(filters.originalJapaneseOnly){
    conditions.push("olang = 'ja'");
  }

  if(filters.englishOnly){
    if(!filters.includeMTL){
      conditions.push('has_en_lang = 1'); // VN level non MTL English existence, matches the live API's "languages" semantics
    }
    conditions.push(filters.includePartialEnglish ? 'has_en_release_any = 1' : 'has_en_release_complete = 1');
  }

  const yearFrom = parseInt(filters.yearFrom, 10);
  if(!isNaN(yearFrom)){
    conditions.push('released_year >= ?');
    params.push(yearFrom);
  }
  const yearTo = parseInt(filters.yearTo, 10);
  if(!isNaN(yearTo)){
    conditions.push('released_year <= ?');
    params.push(yearTo);
  }

  if(Array.isArray(filters.lengths) && filters.lengths.length){
    const validLengths = filters.lengths.map(l => parseInt(l, 10)).filter(l => l >= 1 && l <= 5);
    if(validLengths.length){
      conditions.push(`length IN (${validLengths.map(() => '?').join(',')})`);
      params.push(...validLengths);
    }
  }

  // 0 keeps tag matches from firing off a tag that's only a spoiler for that specific
  // title, 2 (checkbox off) matches at any spoiler level, same meaning as the live API version.
  const spoilerCap = filters.hideSpoilerTagMatches === false ? 2 : 0;

  if(Array.isArray(filters.includeTags) && filters.includeTags.length){
    const tagConds = filters.includeTags.map(t => {
      params.push(String(t.id), spoilerCap);
      return 'EXISTS (SELECT 1 FROM vn_tags WHERE vn_tags.vn_id = vn.id AND vn_tags.tag_id = ? AND vn_tags.spoiler <= ?)';
    });
    conditions.push(filters.includeMode === 'or' && tagConds.length > 1
      ? `(${tagConds.join(' OR ')})`
      : tagConds.join(' AND '));
  }

  if(Array.isArray(filters.excludeTags) && filters.excludeTags.length){
    const tagConds = filters.excludeTags.map(t => {
      params.push(String(t.id), spoilerCap);
      return 'NOT EXISTS (SELECT 1 FROM vn_tags WHERE vn_tags.vn_id = vn.id AND vn_tags.tag_id = ? AND vn_tags.spoiler <= ?)';
    });
    // "exclude only if it has every one" means keep if missing at least one, an OR
    conditions.push(filters.excludeMode === 'and' && tagConds.length > 1
      ? `(${tagConds.join(' OR ')})`
      : tagConds.join(' AND '));
  }

  return { where: conditions.join(' AND '), params };
}

const RESULT_COLUMNS = 'id, title, alttitle, image_path, sexual, votecount, rating, length, length_minutes, description, released_year, platforms, languages';

// True random sampling via an indexed seek on rand_key (assigned once per VN at import
// time, uncorrelated with anything else), not ORDER BY RANDOM(), which would force a
// full scan of every matching row before it could pick from them, this only reads
// roughly as many rows as actually get returned.
function fetchRandomSample(whereClause, params, listSize){
  const threshold = Math.random();

  const forwardSql = `SELECT ${RESULT_COLUMNS} FROM vn WHERE ${whereClause} AND rand_key >= ? ORDER BY rand_key LIMIT ?`;
  let results = db.prepare(forwardSql).all(...params, threshold, listSize);

  if(results.length < listSize){
    const remaining = listSize - results.length;
    const wrapSql = `SELECT ${RESULT_COLUMNS} FROM vn WHERE ${whereClause} AND rand_key < ? ORDER BY rand_key LIMIT ?`;
    const wrapped = db.prepare(wrapSql).all(...params, threshold, remaining);
    results = results.concat(wrapped);
  }

  return results;
}

// Tags are fetched separately from the main VN rows (one IN query covering every
// returned VN at once) rather than joined into the main query, joining would duplicate
// each VN row once per tag it has, breaking the LIMIT. Only id + spoiler level are
// returned, not names, the frontend already has the full tag list loaded locally
// (tags.json) and resolves names from that, so this doesn't need to duplicate it here.
const D1_MAX_BOUND_PARAMS = 100; // no longer a hard SQLite limit, kept for parity/safety

function fetchTagsForVns(vnIds){
  const tagsByVn = {};
  if(!vnIds.length) return tagsByVn;

  for(let i = 0; i < vnIds.length; i += D1_MAX_BOUND_PARAMS){
    const chunk = vnIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = `SELECT vn_id, tag_id, spoiler FROM vn_tags WHERE vn_id IN (${placeholders})`;
    const rows = db.prepare(sql).all(...chunk);
    for(const row of rows){
      if(!tagsByVn[row.vn_id]) tagsByVn[row.vn_id] = [];
      tagsByVn[row.vn_id].push({ id: row.tag_id, spoiler: row.spoiler });
    }
  }

  return tagsByVn;
}

// This is the query that dominates cost on D1, counting means examining every matching
// row, not just the ones actually returned. The underlying data only changes when the
// database is manually refreshed (once a day/week, not in real time), so the same filter
// combination can safely reuse a cached count for a good while instead of repeating that
// scan on every single generate. Was the Workers Cache API on Cloudflare, a plain
// in process Map here since there's only one server process now.
const COUNT_CACHE_SECONDS = 3600;
const countCache = new Map();

function makeCacheKey(whereClause, params){
  const raw = whereClause + '|' + JSON.stringify(params);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function pruneExpiredCacheEntries(){
  const now = Date.now();
  for(const [key, entry] of countCache){
    if(entry.expiresAt <= now) countCache.delete(key);
  }
}

// Real wall-clock cost per stage, the local equivalent of D1's rows_read: since
// better-sqlite3 runs synchronously on the main thread, elapsed time here IS the actual
// work done, not an approximation. Logged server side (visible via `journalctl -u rvng
// -f`) and returned to the client so "how intensive was this search" has a real answer
// instead of a faked number.
function timeMs(fn){
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms };
}

function fetchCount(whereClause, params){
  const cacheKey = makeCacheKey(whereClause, params);
  const cached = countCache.get(cacheKey);
  if(cached && cached.expiresAt > Date.now()){
    return { count: cached.count, cacheHit: true };
  }

  const sql = `SELECT COUNT(*) as count FROM vn WHERE ${whereClause}`;
  const row = db.prepare(sql).get(...params);
  const count = row?.count || 0;

  if(countCache.size > 5000) pruneExpiredCacheEntries();
  countCache.set(cacheKey, { count, expiresAt: Date.now() + COUNT_CACHE_SECONDS * 1000 });

  return { count, cacheHit: false };
}

app.post('/api/generate', rateLimitMiddleware, express.json(), (req, res) => {
  const body = req.body || {};
  const listSize = Math.min(300, Math.max(1, parseInt(body.listSize, 10) || 50));

  let whereClause, params;
  try{
    ({ where: whereClause, params } = buildWhereClause(body));
  }catch(err){
    return res.status(400).json({ error: 'Invalid filters' });
  }

  try{
    const { result: countResult, ms: countMs } = timeMs(() => fetchCount(whereClause, params));
    const { count, cacheHit } = countResult;

    if(!count){
      console.log(`generate: ${countMs.toFixed(1)}ms total (count ${cacheHit ? 'HIT' : 'MISS'} ${countMs.toFixed(1)}ms), 0 matches`);
      return res.json({ count: 0, results: [], debug: { cacheHit, queryMs: Math.round(countMs) } });
    }

    const { result: results, ms: sampleMs } = timeMs(() => fetchRandomSample(whereClause, params, Math.min(listSize, count)));
    const { result: tagsByVn, ms: tagsMs } = timeMs(() => fetchTagsForVns(results.map(r => r.id)));

    const enrichedResults = results.map(vn => ({
      ...vn,
      platforms: safeJsonParse(vn.platforms),
      languages: safeJsonParse(vn.languages),
      tags: tagsByVn[vn.id] || [],
    }));

    const queryMs = countMs + sampleMs + tagsMs;
    console.log(`generate: ${queryMs.toFixed(1)}ms total (count ${cacheHit ? 'HIT' : 'MISS'} ${countMs.toFixed(1)}ms, sample ${sampleMs.toFixed(1)}ms, tags ${tagsMs.toFixed(1)}ms), ${count} matches, ${results.length} returned`);

    res.json({
      count,
      results: enrichedResults,
      // Real wall clock query time, the local equivalent of D1's rows_read cost metric.
      debug: { cacheHit, queryMs: Math.round(queryMs) },
    });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Database query failed', detail: String(err) });
  }
});

app.use(express.static(__dirname));

// Must be declared last, and keep all four params so Express recognizes it as an error handler.
app.use((err, req, res, next) => {
  if(err && err.type === 'entity.parse.failed'){
    return res.status(400).json({ error: 'Invalid request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`rvng server listening on 127.0.0.1:${PORT}`);
});
