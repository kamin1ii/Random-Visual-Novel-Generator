// Shared IP resolution plus both rate limiters: rateLimitMiddleware guards the expensive
// /api/generate endpoint, imageMissAllowed guards the disk-write (cache miss) path on
// /img/*. Kept in one file since they share getClientIp and the same "in-process Map,
// periodic sweep" shape.

export function getClientIp(req){
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

export function rateLimitMiddleware(req, res, next){
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

// Separate, much higher throughput limiter just for the disk write (cache miss) path on
// /img/*, a single page load can legitimately request dozens of covers. Cache hits aren't
// limited at all, they're cheap, this only bounds how many NEW files any one IP can
// cause to be fetched and written to disk.
const IMAGE_MISS_WINDOW_MS = 5 * 60 * 1000;
const IMAGE_MISS_MAX = 100; // generous for real browsing, most covers are already cached after the first person loads them
const imageMissState = new Map(); // ip -> timestamps[]

export function imageMissAllowed(ip){
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
