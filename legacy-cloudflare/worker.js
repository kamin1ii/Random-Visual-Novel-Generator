// Single entry point for the whole Worker. Workers with static assets doesn't have
// Pages' automatic /functions routing, so this checks the path itself. /img/ goes to
// the caching proxy, /api/ goes to the D1-backed list generator, everything else falls
// through to env.ASSETS, the static site.

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    // Done in code rather than a Cloudflare Redirect Rule. Redirect Rules can silently
    // fail to fire when their target is itself a Workers Custom Domain, this way is
    // guaranteed to run since it's the first thing the Worker does.
    if(url.hostname === 'www.randomvn.org'){
      url.hostname = 'randomvn.org';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if(url.pathname.startsWith('/img/')){
      return handleImageProxy(url, env, ctx);
    }

    if(url.pathname === '/api/generate' && request.method === 'POST'){
      return handleGenerate(request, env, ctx);
    }

    if(url.pathname === '/api/db-info' && request.method === 'GET'){
      return handleDbInfo(env);
    }

    return env.ASSETS.fetch(request);
  },
};

const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

async function handleImageProxy(url, env, ctx){
  // path only, never a full URL, so the upstream domain never appears in a client visible request
  const key = url.pathname.slice('/img/'.length);

  if(!key){
    return new Response('Missing image path', { status: 400 });
  }

  const cached = await env.COVERS_BUCKET.get(key);
  if(cached){
    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.httpMetadata?.contentType || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache': 'HIT',
      },
    });
  }

  // the one request per unique image that has to actually reach VNDB
  const upstreamUrl = VNDB_IMAGE_HOST + '/' + key;
  const upstream = await fetch(upstreamUrl);
  if(!upstream.ok){
    return new Response('Upstream fetch failed', { status: upstream.status });
  }

  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await upstream.arrayBuffer();

  // returns immediately, doesn't wait on the R2 write, cache just isn't warm for the next request yet
  ctx.waitUntil(
    env.COVERS_BUCKET.put(key, buffer, {
      httpMetadata: { contentType },
    })
  );

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'MISS',
    },
  });
}

function jsonResponse(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function safeJsonParse(val){
  if(!val) return [];
  try{ return JSON.parse(val); }
  catch(err){ return []; }
}

async function handleDbInfo(env){
  try{
    const row = await env.VNDB_DB.prepare("SELECT value FROM meta WHERE key = 'dump_timestamp'").first();
    return jsonResponse({ dumpTimestamp: row ? row.value : null });
  }catch(err){
    return jsonResponse({ dumpTimestamp: null, error: 'lookup failed' }, 500);
  }
}

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
async function fetchRandomSample(env, whereClause, params, listSize){
  const threshold = Math.random();

  const forwardSql = `SELECT ${RESULT_COLUMNS} FROM vn WHERE ${whereClause} AND rand_key >= ? ORDER BY rand_key LIMIT ?`;
  const forward = await env.VNDB_DB.prepare(forwardSql).bind(...params, threshold, listSize).all();
  let results = forward.results || [];
  let rowsRead = forward.meta?.rows_read || 0;

  if(results.length < listSize){
    const remaining = listSize - results.length;
    const wrapSql = `SELECT ${RESULT_COLUMNS} FROM vn WHERE ${whereClause} AND rand_key < ? ORDER BY rand_key LIMIT ?`;
    const wrapped = await env.VNDB_DB.prepare(wrapSql).bind(...params, threshold, remaining).all();
    results = results.concat(wrapped.results || []);
    rowsRead += wrapped.meta?.rows_read || 0;
  }

  return { results, rowsRead };
}

// Hashed rather than used directly as a URL, keeps the cache key a fixed, safe length
// regardless of how many tag conditions a filter combination ends up producing.
async function makeCacheKey(whereClause, params){
  const raw = whereClause + '|' + JSON.stringify(params);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashHex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://cache.internal/count/${hashHex}`);
}

// This is the query that dominates D1 read cost, counting means examining every
// matching row, not just the ones actually returned. The underlying data only changes
// when the database is manually refreshed (once a day/week, not in real time), so the
// same filter combination can safely reuse a cached count for a good while instead of
// repeating that scan on every single generate.
const COUNT_CACHE_SECONDS = 3600;

async function fetchCount(env, whereClause, params, ctx){
  const cache = caches.default;
  const cacheKey = await makeCacheKey(whereClause, params);

  const cached = await cache.match(cacheKey);
  if(cached){
    const data = await cached.json();
    return { count: data.count, cacheHit: true, rowsRead: 0 };
  }

  // .all() rather than .first(), D1 only exposes query metadata (rows_read) on .all(),
  // .first() returns just the bare row with no metadata attached.
  const sql = `SELECT COUNT(*) as count FROM vn WHERE ${whereClause}`;
  const result = await env.VNDB_DB.prepare(sql).bind(...params).all();
  const count = result.results?.[0]?.count || 0;
  const rowsRead = result.meta?.rows_read || 0;

  const response = new Response(JSON.stringify({ count }), {
    headers: { 'Cache-Control': `public, max-age=${COUNT_CACHE_SECONDS}`, 'Content-Type': 'application/json' },
  });
  ctx.waitUntil(cache.put(cacheKey, response)); // doesn't delay the actual response, cache just isn't warm for the next request yet

  return { count, cacheHit: false, rowsRead };
}

// Tags are fetched separately from the main VN rows (one IN query covering every
// returned VN at once) rather than joined into the main query, joining would duplicate
// each VN row once per tag it has, breaking the LIMIT. Only id + spoiler level are
// returned, not names, the frontend already has the full tag list loaded locally
// (tags.json) and resolves names from that, so this doesn't need to duplicate it here.
// Chunked into groups of 100: D1 has a hard limit of 100 bound parameters per query,
// and this binds one parameter per VN id, a single query for a large title list would
// blow past that limit entirely, this is what broke generates over 100 titles.
const D1_MAX_BOUND_PARAMS = 100;

async function fetchTagsForVns(env, vnIds){
  if(!vnIds.length) return { tagsByVn: {}, rowsRead: 0 };
  const tagsByVn = {};
  let rowsRead = 0;

  for(let i = 0; i < vnIds.length; i += D1_MAX_BOUND_PARAMS){
    const chunk = vnIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = `SELECT vn_id, tag_id, spoiler FROM vn_tags WHERE vn_id IN (${placeholders})`;
    const result = await env.VNDB_DB.prepare(sql).bind(...chunk).all();
    rowsRead += result.meta?.rows_read || 0;
    for(const row of (result.results || [])){
      if(!tagsByVn[row.vn_id]) tagsByVn[row.vn_id] = [];
      tagsByVn[row.vn_id].push({ id: row.tag_id, spoiler: row.spoiler });
    }
  }

  return { tagsByVn, rowsRead };
}

async function handleGenerate(request, env, ctx){
  let body;
  try{
    body = await request.json();
  }catch(err){
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const listSize = Math.min(300, Math.max(1, parseInt(body.listSize, 10) || 50));

  let whereClause, params;
  try{
    ({ where: whereClause, params } = buildWhereClause(body));
  }catch(err){
    return jsonResponse({ error: 'Invalid filters' }, 400);
  }

  try{
    const { count, cacheHit, rowsRead: countRowsRead } = await fetchCount(env, whereClause, params, ctx);
    if(!count){
      return jsonResponse({ count: 0, results: [], debug: { cacheHit, rowsRead: countRowsRead } });
    }

    const { results, rowsRead: sampleRowsRead } = await fetchRandomSample(env, whereClause, params, Math.min(listSize, count));
    const { tagsByVn, rowsRead: tagsRowsRead } = await fetchTagsForVns(env, results.map(r => r.id));

    const enrichedResults = results.map(vn => ({
      ...vn,
      platforms: safeJsonParse(vn.platforms),
      languages: safeJsonParse(vn.languages),
      tags: tagsByVn[vn.id] || [],
    }));

    const totalRowsRead = countRowsRead + sampleRowsRead + tagsRowsRead;

    return jsonResponse({
      count,
      results: enrichedResults,
      debug: { cacheHit, rowsRead: totalRowsRead },
    });
  }catch(err){
    return jsonResponse({ error: 'Database query failed', detail: String(err) }, 500);
  }
}
