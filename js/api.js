import { API, VN_FIELDS, PER_PAGE } from './constants.js?v=34';

export async function vndbQuery(endpoint, body){
  const res = await fetch(API + '/' + endpoint, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  // fetch() only rejects on network failure, not HTTP error codes
  if(!res.ok) throw new Error('VNDB request failed (' + res.status + ')');
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

export async function runQuery(filters, listSize){
  const countData = await vndbQuery('vn', { filters, fields:'id', results:1, count:true });
  const count = countData.count || 0;
  if(!count) return { count:0, results:[] };

  const effectiveSize = Math.min(listSize, count);

  if(effectiveSize <= PER_PAGE){
    // Random page (not always page 1) is what makes repeated generates return different
    // VNs. Restricted to FULL pages only: if count isn't an exact multiple of effectiveSize,
    // the trailing page holds just the remainder, and landing on it silently returns fewer
    // results than requested even though enough matches exist elsewhere in the set.
    const fullPages = Math.max(1, Math.floor(count / effectiveSize));
    const randomPage = Math.floor(Math.random() * fullPages) + 1;
    const data = await vndbQuery('vn', { filters, fields: VN_FIELDS, results:effectiveSize, page:randomPage, sort:'id' });
    const results = shuffle(data.results || []);
    return { count, results };
  }

  // VNDB caps a single request at PER_PAGE, so bigger lists need several stitched together
  const pagesNeeded = Math.ceil(effectiveSize / PER_PAGE);
  // Same full-page problem as above, but in item offsets rather than page numbers, since
  // pagesNeeded pages starting too late could still end with a partially-filled last page
  const maxOffset = count - effectiveSize;
  const maxStartPage = Math.max(1, Math.floor(maxOffset / PER_PAGE) + 1);
  const startPage = 1 + Math.floor(Math.random() * maxStartPage);

  const pageNums = [];
  for(let p = startPage; p < startPage + pagesNeeded; p++) pageNums.push(p);

  // parallel, not sequential, waiting on each one in turn would make large lists slow
  const pageResponses = await Promise.all(
    pageNums.map(p => vndbQuery('vn', { filters, fields: VN_FIELDS, results:PER_PAGE, page:p, sort:'id' }))
  );

  let results = [];
  pageResponses.forEach(d => { results = results.concat(d.results || []); });

  results = shuffle(results.slice(0, effectiveSize)); // last page in range may return fewer than requested
  return { count, results };
}
