import { els } from './dom.js?v=30';
import { SENSITIVE_THRESHOLD } from './constants.js?v=30';

// Routes cover images through our own /img/<path> proxy (a Cloudflare Worker) instead
// of VNDB's CDN directly. The proxy caches each image in R2 on first request and serves
// every request after that from our own storage, so VNDB only ever sees one request per
// unique cover, across all visitors combined, not once per visitor per view. Using just
// the image's path (not the full VNDB URL) as the visible request keeps the actual
// upstream domain out of anything client-visible, the worker reconstructs it internally.
function proxiedImageUrl(vndbUrl){
  const path = new URL(vndbUrl).pathname.replace(/^\/+/, '');
  return '/img/' + path;
}

// Caches Image() objects for covers the person hasn't reached yet, so navigating there
// later is instant instead of waiting on a fresh download. Capped in size so a long
// browsing session doesn't quietly build up unbounded memory.
const preloadCache = new Map();
const MAX_PRELOAD_CACHE = 150;

function rememberPreload(id, img){
  preloadCache.set(id, img);
  if(preloadCache.size > MAX_PRELOAD_CACHE){
    preloadCache.delete(preloadCache.keys().next().value); // Map preserves insertion order, oldest is first
  }
}

// Low fetch priority so the browser favors whatever image the person is actually
// looking at right now if bandwidth is limited.
function preloadImages(vns){
  vns.forEach(vn => {
    if(!vn || !vn.image || !vn.image.url) return;
    if(preloadCache.has(vn.id)) return;
    const img = new Image();
    img.fetchPriority = 'low';
    img.src = proxiedImageUrl(vn.image.url);
    rememberPreload(vn.id, img);
  });
}

// Deferred to idle time rather than fired immediately, so these background downloads
// don't compete for bandwidth with the current image, which should load first.
export function preloadAround(list, index, radius = 5){
  if(!list.length) return;
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
}

// Bumped on every render so an in-flight image callback can check it still belongs to
// the current entry before touching anything, this is the backstop for any stale-callback
// case that clearing onload/onerror alone doesn't cover, like a timeout firing after the
// person has already navigated elsewhere.
let renderToken = 0;
const IMAGE_LOAD_TIMEOUT_MS = 10000; // covers a request that stalls without firing load or error at all

function isReadyToShow(vn){
  const img = preloadCache.get(vn.id);
  return !!(img && img.complete && img.naturalWidth > 0);
}

// Drives the cover image for the current VN: cache hit, fresh download, or no-image
// fallback, including the sensitive-image blur/reveal state. Everything here is about
// *how the image gets on screen*, not about what VN data is being shown.
export function showCover(vn){
  // Cleared up front so a "load" event that fires late for a stale image (from a few
  // entries ago) can't run later and wrongly toggle the blur for whatever's showing by then.
  els.cover.onload = null;
  els.cover.onerror = null;
  const myToken = ++renderToken; // any callback below checks this before touching anything

  // Hidden immediately, before anything else, and flushed with a reflow so it actually
  // paints this frame. Browsers don't clear an <img>'s pixels the moment src changes,
  // they keep showing whatever was last painted until the new image is ready, so
  // without this a fast navigate could leave the *previous* VN's poster on screen
  // (looking like a wrong/repeated cover) for however long the new one takes to load.
  els.cover.classList.add('no-anim');
  els.cover.classList.remove('loaded', 'sensitive');
  els.revealBtn.classList.remove('show');
  els.coverFallback.style.display = 'none';
  void els.cover.offsetWidth; // forces the hide above to actually apply before we go further

  if(!vn.image || !vn.image.url){
    els.coverLoading.classList.remove('show');
    els.cover.removeAttribute('src');
    els.coverFallback.style.display = 'flex';
    return;
  }

  const isSensitive = vn.image.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD;
  const alreadyCached = isReadyToShow(vn); // skip the spinner for this one, but still wait for "load" to reveal it

  if(!alreadyCached) els.coverLoading.classList.add('show');

  // Whether cached or not, revealing only ever happens from this "load" handler, never
  // optimistically. For a true cache hit the browser fires it essentially instantly, so
  // there's no visible delay, but it also means a cache hit that turns out not to be as
  // instant as expected (slow disk cache, revalidation, etc.) never shows a stale poster
  // in the meantime, since the cover stayed hidden until this actually runs.
  els.cover.onload = () => {
    if(myToken !== renderToken) return; // a newer render has since taken over the element
    clearTimeout(timeoutId);
    els.coverLoading.classList.remove('show');
    // Blur is applied while still "no-anim", so it's already correct before the
    // opacity fade-in starts, otherwise a sensitive image would briefly show unblurred.
    if(isSensitive) els.cover.classList.add('sensitive');
    void els.cover.offsetWidth; // without this reflow, removing no-anim next could animate the blur too
    els.cover.classList.remove('no-anim');
    els.cover.classList.add('loaded');
    if(isSensitive) els.revealBtn.classList.add('show');
  };
  els.cover.onerror = () => {
    if(myToken !== renderToken) return;
    clearTimeout(timeoutId);
    els.coverLoading.classList.remove('show');
    els.coverFallback.style.display = 'flex';
  };
  // A stalled request that never fires load or error would otherwise leave the
  // cover hidden (and possibly the spinner spinning) stuck indefinitely, this forces
  // a resolution either way.
  const timeoutId = setTimeout(() => {
    if(myToken !== renderToken) return;
    els.coverLoading.classList.remove('show');
    els.coverFallback.style.display = 'flex';
  }, IMAGE_LOAD_TIMEOUT_MS);
  els.cover.src = proxiedImageUrl(vn.image.url);
}
