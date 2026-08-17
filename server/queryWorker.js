// Runs the actual /api/generate SQLite work inside a worker thread instead of on the
// main thread. better-sqlite3 calls are synchronous, so without this every concurrent
// request would queue behind Node's single event loop no matter how many CPU cores the
// VPS has. Opens its own read only connection, SQLite allows any number of concurrent
// readers against the same file.

import { parentPort } from 'node:worker_threads';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const RESULT_COLUMNS = 'id, title, alttitle, image_path, sexual, votecount, rating, length, length_minutes, description, released_year, platforms, languages';
const D1_MAX_BOUND_PARAMS = 100; // no longer a hard SQLite limit, kept for parity/safety

// The underlying data only changes when the database is manually refreshed (once a day
// or so, not in real time), so the same filter combination can safely reuse a cached
// count for a good while instead of repeating that scan on every single generate. Each
// worker keeps its own copy of this cache rather than sharing one across the pool, a
// little redundant memory in exchange for not needing any cross thread coordination.
const COUNT_CACHE_SECONDS = 3600;
const countCache = new Map();

function safeJsonParse(val){
  if(!val) return [];
  try{ return JSON.parse(val); }
  catch(err){ return []; }
}

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

// Real wall clock cost per stage. Since better-sqlite3 runs synchronously within this
// worker, elapsed time here IS the actual work done, not an approximation.
function timeMs(fn){
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms };
}

function runGenerate(whereClause, params, listSize){
  const { result: countResult, ms: countMs } = timeMs(() => fetchCount(whereClause, params));
  const { count, cacheHit } = countResult;

  if(!count){
    return { count: 0, results: [], cacheHit, queryMs: Math.round(countMs) };
  }

  const { result: results, ms: sampleMs } = timeMs(() => fetchRandomSample(whereClause, params, Math.min(listSize, count)));
  const { result: tagsByVn, ms: tagsMs } = timeMs(() => fetchTagsForVns(results.map(r => r.id)));

  const enrichedResults = results.map(vn => ({
    ...vn,
    platforms: safeJsonParse(vn.platforms),
    languages: safeJsonParse(vn.languages),
    tags: tagsByVn[vn.id] || [],
  }));

  return { count, results: enrichedResults, cacheHit, queryMs: Math.round(countMs + sampleMs + tagsMs) };
}

parentPort.on('message', (job) => {
  try{
    const response = runGenerate(job.whereClause, job.params, job.listSize);
    parentPort.postMessage({ id: job.id, ...response });
  }catch(err){
    parentPort.postMessage({ id: job.id, error: String(err) });
  }
});
