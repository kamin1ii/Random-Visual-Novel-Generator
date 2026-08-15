import { els } from './dom.js?v=47';
import { SENSITIVE_THRESHOLD } from './constants.js?v=47';

// Routes through our own /img/<path> proxy instead of VNDB directly. The proxy caches
// each image in R2 on first request, so VNDB sees one request per unique cover total,
// not one per visitor. Absolute URL with the canonical domain hardcoded explicitly,
// rather than a relative path, closes off any chance of the browser resolving it
// against www.randomvn.org and needing an extra redirect hop before landing on the
// correct domain, regardless of what causes that resolution to happen.
const SITE_ORIGIN = 'https://randomvn.org';
function proxiedImageUrl(vndbUrl){
  const path = new URL(vndbUrl).pathname.replace(/^\/+/, '');
  return SITE_ORIGIN + '/img/' + path;
}

// Preloaded Image() objects for covers the person hasn't reached yet, capped so a long
// session doesn't build up unbounded memory.
const preloadCache = new Map();
const MAX_PRELOAD_CACHE = 150;

function rememberPreload(id, img){
  preloadCache.set(id, img);
  if(preloadCache.size > MAX_PRELOAD_CACHE){
    preloadCache.delete(preloadCache.keys().next().value); // Map preserves insertion order
  }
}

function preloadImages(vns){
  vns.forEach(vn => {
    if(!vn || !vn.image || !vn.image.url) return;
    if(preloadCache.has(vn.id)) return;
    const img = new Image();
    img.fetchPriority = 'low'; // don't compete with whatever's actually on screen right now
    img.src = proxiedImageUrl(vn.image.url);
    rememberPreload(vn.id, img);
  });
}

// Debounced: rapid navigation (holding an arrow key, spam-clicking Next) would otherwise
// queue a fresh preload scan on every single step passed through, each one requesting up
// to 10 images that get abandoned the instant the next step fires anyway. Collapsing this
// to one scan, for wherever navigation actually settles, cuts a lot of wasted requests to
// the image proxy during a fast burst without affecting normal one-click-at-a-time browsing,
// where this fires almost immediately after the (isolated) click either way.
let preloadDebounceTimer = null;
const PRELOAD_DEBOUNCE_MS = 200;

export function preloadAround(list, index, radius = 5){
  // A list of 1 (the startup pick) has no genuine neighbors, every offset would wrap
  // back to the same single item, redundantly re-fetching the image already being shown.
  if(list.length <= 1) return;
  clearTimeout(preloadDebounceTimer);
  preloadDebounceTimer = setTimeout(() => {
    const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    schedule(() => {
      const targets = [];
      for(let offset = -radius; offset <= radius; offset++){
        if(offset === 0) continue;
        const i = ((index + offset) % list.length + list.length) % list.length; // wraps at both ends
        targets.push(list[i]);
      }
      preloadImages(targets);
    });
  }, PRELOAD_DEBOUNCE_MS);
}

// Bumped every render so a stale in-flight callback (a late load/error/timeout from a
// few entries back) can check it's still current before touching anything.
let renderToken = 0;
const IMAGE_LOAD_TIMEOUT_MS = 10000;

function isReadyToShow(vn){
  const img = preloadCache.get(vn.id);
  return !!(img && img.complete && img.naturalWidth > 0);
}

// Debounced the same way as preloadAround, and for the same reason: only applies to the
// case that actually costs a network request (an uncached cover). A cover that's already
// preloaded (the common case for normal browsing) skips this and loads instantly, nothing
// to collapse there since no request is being made in the first place.
let fetchDebounceTimer = null;
const FETCH_DEBOUNCE_MS = 180;

export function showCover(vn, isRetry){
  els.cover.onload = null;
  els.cover.onerror = null;
  clearTimeout(fetchDebounceTimer);
  const myToken = ++renderToken;

  // Hidden immediately and flushed with a reflow. Browsers keep showing an <img>'s last
  // painted pixels until the new src is ready, not blank, so without this a fast navigate
  // could leave the *previous* VN's poster on screen looking like a wrong/repeated cover.
  els.cover.classList.add('no-anim');
  els.cover.classList.remove('loaded', 'sensitive');
  els.revealBtn.classList.remove('show');
  els.coverFallback.style.display = 'none';
  void els.cover.offsetWidth;

  if(!vn.image || !vn.image.url){
    els.coverLoading.classList.remove('show');
    els.cover.removeAttribute('src');
    els.coverFallback.textContent = 'No cover art on file.';
    els.coverFallback.style.display = 'flex';
    return;
  }

  const isSensitive = vn.image.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD;
  const alreadyCached = isReadyToShow(vn);

  // Shown on a load failure, this could be a genuinely missing cover, or it could be
  // navigating fast enough to briefly hit the image proxy's rate limit, there's no way
  // to tell which from here (that would need switching from <img src> to fetch-based
  // loading, more complexity than this is worth). The retry below covers the rate-limit
  // case without needing to actually detect it: if that's what happened, retrying after
  // the window passes succeeds, if the cover genuinely doesn't exist, it just fails
  // quietly again and stops there, isRetry prevents this from looping forever.
  function showLoadFailure(){
    els.coverLoading.classList.remove('show');
    els.coverFallback.textContent = isRetry
      ? 'No cover image found.'
      : 'Failed to load the cover, retrying in 10s\u2026';
    els.coverFallback.style.display = 'flex';
    if(!isRetry){
      setTimeout(() => {
        if(myToken === renderToken) showCover(vn, true);
      }, 11000);
    }
  }

  function startLoad(){
    if(myToken !== renderToken) return; // superseded before this even fired

    // Reveal only ever happens from "load", never optimistically, even on a cache hit.
    // A true hit fires this near-instantly so there's no visible delay, but it also means
    // a hit that isn't quite as instant as expected never shows a stale poster in the meantime.
    els.cover.onload = () => {
      if(myToken !== renderToken) return;
      clearTimeout(timeoutId);
      els.coverLoading.classList.remove('show');
      if(isSensitive) els.cover.classList.add('sensitive'); // set while still no-anim, so it's correct before the fade-in starts
      void els.cover.offsetWidth;
      els.cover.classList.remove('no-anim');
      els.cover.classList.add('loaded');
      if(isSensitive) els.revealBtn.classList.add('show');
    };
    els.cover.onerror = () => {
      if(myToken !== renderToken) return;
      clearTimeout(timeoutId);
      showLoadFailure();
    };
    // backstop for a request that stalls without ever firing load or error
    const timeoutId = setTimeout(() => {
      if(myToken !== renderToken) return;
      showLoadFailure();
    }, IMAGE_LOAD_TIMEOUT_MS);
    els.cover.src = proxiedImageUrl(vn.image.url);
  }

  if(alreadyCached){
    els.coverLoading.classList.remove('show');
    startLoad(); // no network request happening here, nothing to debounce
  } else {
    els.coverLoading.classList.add('show');
    fetchDebounceTimer = setTimeout(startLoad, FETCH_DEBOUNCE_MS);
  }
}
