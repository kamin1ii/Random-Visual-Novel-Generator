// /api/generate and /api/db-info, the actual query engine. Filters get turned into a
// parameterized WHERE clause, matched VNs are picked via a true random indexed seek
// (rand_key), and tags for the returned VNs are fetched separately.

import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { rateLimitMiddleware } from './rateLimit.js';

export const generateRouter = express.Router();

function safeJsonParse(val){
  if(!val) return [];
  try{ return JSON.parse(val); }
  catch(err){ return []; }
}

generateRouter.get('/api/db-info', (req, res) => {
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
  // Baseline, always applied regardless of UI settings. released_year is only ever set
  // (db/refresh-vndb-db.mjs, deriveReleaseFlags) from a release that's actually out, not
  // an announced/TBA one, so NULL here means literally nothing about this VN has released
  // yet, an announce only or still in development title shouldn't turn up in a "generate
  // a real thing to play" tool no matter what filters are set.
  const conditions = ['has_description = 1', 'released_year IS NOT NULL'];
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
    // All 5 checked means the same thing as none checked ("don't care"), everywhere else
    // in this UI an empty selection means no restriction, this should behave the same way
    // rather than emitting length IN (1,2,3,4,5), which (unlike skipping the condition
    // entirely) actively excludes any VN whose length category isn't set at all, NULL
    // never satisfies IN(), so those titles silently vanished even with every box checked.
    if(validLengths.length && validLengths.length < 5){
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

// Real wall clock cost per stage, the local equivalent of D1's rows_read. Since
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

generateRouter.post('/api/generate', rateLimitMiddleware, express.json(), (req, res) => {
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
