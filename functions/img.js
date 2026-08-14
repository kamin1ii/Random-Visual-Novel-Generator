// Cloudflare Pages Function, routed automatically at /img (file-based routing: this
// file's path under functions/ becomes its URL path). Proxies and caches VN cover
// images in R2, so the first person to ever view a given cover triggers one request to
// VNDB, and every request after that (from any visitor, not just the same device) is
// served straight from our own bucket. The R2 bucket must be bound to this Pages
// project as COVERS_BUCKET (Pages project settings -> Functions -> R2 bucket bindings).

export async function onRequestGet(context){
  const { request, env } = context;
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
      },
    });
  }

  // Cache miss: this is the one request per unique image that has to actually reach
  // VNDB, see the earlier conversation about why that first fetch is unavoidable.
  const upstream = await fetch(imgUrl);
  if(!upstream.ok){
    return new Response('Upstream fetch failed', { status: upstream.status });
  }

  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await upstream.arrayBuffer();

  // waitUntil lets the response return immediately without waiting for the R2 write to
  // finish, the person gets their image right away, the cache just isn't warm for the
  // *next* request until this completes (normally well under a second later).
  context.waitUntil(
    env.COVERS_BUCKET.put(key, buffer, {
      httpMetadata: { contentType },
    })
  );

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
