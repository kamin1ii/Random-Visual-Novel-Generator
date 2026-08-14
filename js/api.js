import { API, VN_FIELDS, PER_PAGE } from './constants.js?v=22';

export async function vndbQuery(endpoint, body){
  const res = await fetch(API + '/' + endpoint, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  // fetch only rejects on network failure, not on HTTP error codes, so this has to be checked manually
  if(!res.ok) throw new Error('VNDB request failed (' + res.status + ')');
  return res.json();
}

// Fisher-Yates, used because the page of results returned by VNDB is in id order,
// without this the list would browse in a predictable, non-random sequence.
function shuffle(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function runQuery(filters, listSize){
  // A cheap results:1 request just for the count, so the random page can be chosen
  // without downloading full VN data twice.
  const countData = await vndbQuery('vn', { filters, fields:'id', results:1, count:true });
  const count = countData.count || 0;
  if(!count) return { count:0, results:[] };

  const effectiveSize = Math.min(listSize, count); // never ask for more than actually exists

  if(effectiveSize <= PER_PAGE){
    // Fits in one request. A random page (rather than always page 1) is what makes
    // repeated generates with the same filters return different VNs.
    // Only pages guaranteed to be FULL (size effectiveSize) are eligible: if count isn't
    // an exact multiple of effectiveSize, the trailing page only holds the remainder and
    // landing on it would silently return fewer than effectiveSize results even though
    // effectiveSize titles' worth of matches exist elsewhere in the set.
    const fullPages = Math.max(1, Math.floor(count / effectiveSize));
    const randomPage = Math.floor(Math.random() * fullPages) + 1;
    const data = await vndbQuery('vn', { filters, fields: VN_FIELDS, results:effectiveSize, page:randomPage, sort:'id' });
    const results = shuffle(data.results || []);
    return { count, results };
  }

  // VNDB caps each request at PER_PAGE, so list sizes above that need several requests
  // stitched together. A random starting page (not always the first) keeps this varied
  // the same way the single-request branch above does.
  const pagesNeeded = Math.ceil(effectiveSize / PER_PAGE);
  // Expressed in actual item offsets rather than whole pages: this is the highest 0-indexed
  // starting position that still leaves effectiveSize real items ahead of it. Restricting to
  // page boundaries alone (as if every page were guaranteed full) could still let the random
  // start land late enough that the trailing, partially-filled page gets pulled into the
  // batch and the total comes up short of effectiveSize, the same failure mode as the
  // single-request branch above.
  const maxOffset = count - effectiveSize;
  const maxStartPage = Math.max(1, Math.floor(maxOffset / PER_PAGE) + 1);
  const startPage = 1 + Math.floor(Math.random() * maxStartPage);

  const pageNums = [];
  for(let p = startPage; p < startPage + pagesNeeded; p++) pageNums.push(p);

  // Fired in parallel rather than sequentially, since these are independent requests
  // and waiting for each one in turn would make large lists noticeably slower to build.
  const pageResponses = await Promise.all(
    pageNums.map(p => vndbQuery('vn', { filters, fields: VN_FIELDS, results:PER_PAGE, page:p, sort:'id' }))
  );

  let results = [];
  pageResponses.forEach(d => { results = results.concat(d.results || []); });

  // the final page in the range can return fewer items than requested, trim to the exact size
  results = shuffle(results.slice(0, effectiveSize));
  return { count, results };
}
