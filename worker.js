// Single entry point for the whole Worker. Cloudflare's Workers-with-static-assets
// model doesn't have Pages' automatic /functions folder routing, so this script has to
// check the path itself: /img goes to the caching proxy below, everything else falls
// through to env.ASSETS, which serves the static site (same files GitHub Pages serves).

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname === '/img'){
      return handleImageProxy(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleImageProxy(request, env, ctx){
  const requestUrl = new URL(request.url);
  const imgUrl = requestUrl.searchParams.get('url');

  if(!imgUrl){
    return new Response('Missing url parameter', { status: 400 });
  }

  let parsed;
  try{
    parsed = new URL(imgUrl);
  }catch(err){
    return new Response('Invalid url parameter', { status: 400 });
  }

  // Only ever proxies VNDB's own image CDN, never an arbitrary URL. Without this check
  // the endpoint would be an open proxy anyone could point at any URL, using our
  // bucket and bandwidth to cache and serve whatever they want.
  if(parsed.hostname !== 'vndb.org' && !parsed.hostname.endsWith('.vndb.org')){
    return new Response('URL not allowed', { status: 403 });
  }

  // VNDB's own URL path already uniquely identifies the image, so it doubles as a
  // stable R2 object key, no need to hash or invent a separate ID scheme.
  const key = parsed.pathname.replace(/^\/+/, '');

  const cached = await env.COVERS_BUCKET.get(key);
  if(cached){
    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.httpMetadata?.contentType || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache': 'HIT', // served from R2, VNDB was never contacted for this request
      },
    });
  }

  // Cache miss: this is the one request per unique image that has to actually reach
  // VNDB, unavoidable since the cache starts out empty for every image.
  const upstream = await fetch(imgUrl);
  if(!upstream.ok){
    return new Response('Upstream fetch failed', { status: upstream.status });
  }

  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await upstream.arrayBuffer();

  // waitUntil lets the response return immediately without waiting for the R2 write to
  // finish, the person gets their image right away, the cache just isn't warm for the
  // *next* request until this completes (normally well under a second later).
  ctx.waitUntil(
    env.COVERS_BUCKET.put(key, buffer, {
      httpMetadata: { contentType },
    })
  );

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'MISS', // this request actually went out to VNDB
    },
  });
}
