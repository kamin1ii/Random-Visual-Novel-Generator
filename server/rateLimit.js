// Shared IP resolution plus every rate limiter: rateLimitMiddleware guards the expensive
// /api/generate endpoint, imageRequestAllowed guards every /img/* request, and
// imageMissAllowed additionally guards just the disk write (cache miss) path within that.
// Kept in one file since they share getClientIp and (the two image limiters) the same
// in process Map, periodic sweep shape.

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

// Small reusable per IP sliding window limiter, same "in process Map, periodic sweep"
// shape as imageMissAllowed and imageRequestAllowed both need below, kept as one factory
// instead of copy pasting the window/sweep logic a second time.
function createWindowLimiter(windowMs, max){
  const state = new Map(); // ip -> timestamps[]

  setInterval(() => {
    const now = Date.now();
    for(const [ip, timestamps] of state){
      const fresh = timestamps.filter(t => now - t < windowMs);
      if(fresh.length === 0) state.delete(ip);
      else state.set(ip, fresh);
    }
  }, 60 * 1000).unref();

  return function isAllowed(ip){
    const now = Date.now();
    const timestamps = state.get(ip) || [];
    const fresh = timestamps.filter(t => now - t < windowMs);
    if(fresh.length >= max){
      state.set(ip, fresh);
      return false;
    }
    fresh.push(now);
    state.set(ip, fresh);
    return true;
  };
}

// General limiter on every /img/* request, hits included, not just misses. A cache hit is
// cheap in CPU/IO terms, but it still costs real egress bandwidth off this VPS, unlike the
// old Cloudflare/R2 setup, that bandwidth now counts against this server's own transfer
// allowance, so even "cheap" requests are worth bounding against a scripted client
// hammering already cached images. Matches the 90 requests per 10 seconds rule this site ran under R2.
export const imageRequestAllowed = createWindowLimiter(10 * 1000, 90);

// Separate, much higher throughput limiter just for the disk write (cache miss) path on
// /img/*, a single page load can legitimately request dozens of covers. This only bounds
// how many NEW files any one IP can cause to be fetched and written to disk, on top of
// the general limiter above, which every request already has to pass regardless.
export const imageMissAllowed = createWindowLimiter(5 * 60 * 1000, 100);
