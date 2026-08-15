import { API, VN_FIELDS, PER_PAGE } from './constants.js?v=42';

export async function vndbQuery(endpoint, body){
  const res = await fetch(API + '/' + endpoint, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  // fetch() only rejects on network failure, not HTTP error codes
  if(!res.ok){
    const err = new Error('VNDB request failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// results come back in id order, shuffle so the list doesn't browse in a predictable sequence
function shuffle(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Single-request version for when only a small pool is needed to pick ONE item from
// (like the startup placeholder pick), not a full list to browse. Scattering across
// multiple draws (see runQuery below) only matters when someone's actually browsing
// many titles from it, since only one item from this pool ever gets used, that concern
// doesn't apply, one request for a modest pool is all this needs.
export async function fetchRandomPool(filters, poolSize){
  const countData = await vndbQuery('vn', { filters, fields:'id', results:1, count:true });
  const count = countData.count || 0;
  if(!count) return { count:0, results:[] };

  const effectiveSize = Math.min(poolSize, count);
  const fullPages = Math.max(1, Math.floor(count / effectiveSize));
  const randomPage = Math.floor(Math.random() * fullPages) + 1;
  const data = await vndbQuery('vn', { filters, fields: VN_FIELDS, results:effectiveSize, page:randomPage, sort:'id' });
  const results = shuffle(data.results || []);
  return { count, results };
}

// How many independent random draws to split a list into. More draws means titles get
// pulled from more scattered positions across the matching pool instead of one
// contiguous block, since VNDB's IDs cluster somewhat by when a title was added, one
// random page alone can still land on a run of related/same-era titles.
const DESIRED_DRAWS = 5;
const MIN_CHUNK_SIZE = 5; // keeps draws from being pointlessly tiny on small lists

export async function runQuery(filters, listSize){
  const countData = await vndbQuery('vn', { filters, fields:'id', results:1, count:true });
  const count = countData.count || 0;
  if(!count) return { count:0, results:[] };

  const effectiveSize = Math.min(listSize, count);

  let numDraws = Math.max(1, Math.min(DESIRED_DRAWS, effectiveSize, Math.floor(effectiveSize / MIN_CHUNK_SIZE) || 1));
  // safety bound in case effectiveSize is ever large enough that a chunk would exceed
  // VNDB's single-request cap, not reachable with the sizes this app currently offers
  while(Math.ceil(effectiveSize / numDraws) > PER_PAGE) numDraws++;

  const baseChunk = Math.floor(effectiveSize / numDraws);
  const remainder = effectiveSize % numDraws;

  const drawPromises = [];
  for(let i = 0; i < numDraws; i++){
    const chunkSize = baseChunk + (i < remainder ? 1 : 0); // spreads the remainder across the first few draws
    if(chunkSize <= 0) continue;
    // Full pages only, same reasoning as before: a page sized to a chunk that isn't a
    // full page could land on a trailing partial page and return fewer than requested.
    const fullPages = Math.max(1, Math.floor(count / chunkSize));
    const randomPage = Math.floor(Math.random() * fullPages) + 1;
    drawPromises.push(
      vndbQuery('vn', { filters, fields: VN_FIELDS, results: chunkSize, page: randomPage, sort: 'id' })
    );
  }

  const drawResponses = await Promise.all(drawPromises);

  // separate random draws can coincidentally land on the same page and return the same
  // VN more than once, deduped here before shuffling
  const seen = new Set();
  let results = [];
  drawResponses.forEach(d => {
    (d.results || []).forEach(vn => {
      if(!seen.has(vn.id)){
        seen.add(vn.id);
        results.push(vn);
      }
    });
  });

  results = shuffle(results).slice(0, effectiveSize);
  return { count, results };
}
