import { els } from './dom.js?v=33';
import { SENSITIVE_THRESHOLD } from './constants.js?v=33';

// Routes through our own /img/<path> proxy instead of VNDB directly. The proxy caches
// each image in R2 on first request, so VNDB sees one request per unique cover total,
// not one per visitor. Path only (no full URL) keeps the upstream domain out of anything
// client-visible.
function proxiedImageUrl(vndbUrl){
  const path = new URL(vndbUrl).pathname.replace(/^\/+/, '');
  return '/img/' + path;
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

// deferred to idle time so it doesn't compete with the current image's own load
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

// Bumped every render so a stale in flight callback (a late load/error/timeout from a
// few entries back) can check it's still current before touching anything.
let renderToken = 0;
const IMAGE_LOAD_TIMEOUT_MS = 10000;

function isReadyToShow(vn){
  const img = preloadCache.get(vn.id);
  return !!(img && img.complete && img.naturalWidth > 0);
}

export function showCover(vn){
  els.cover.onload = null;
  els.cover.onerror = null;
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
    els.coverFallback.style.display = 'flex';
    return;
  }

  const isSensitive = vn.image.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD;
  const alreadyCached = isReadyToShow(vn);

  if(!alreadyCached) els.coverLoading.classList.add('show');

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
    els.coverLoading.classList.remove('show');
    els.coverFallback.style.display = 'flex';
  };
  // backstop for a request that stalls without ever firing load or error
  const timeoutId = setTimeout(() => {
    if(myToken !== renderToken) return;
    els.coverLoading.classList.remove('show');
    els.coverFallback.style.display = 'flex';
  }, IMAGE_LOAD_TIMEOUT_MS);
  els.cover.src = proxiedImageUrl(vn.image.url);
}
