// Single entry point for the whole Worker. Cloudflare's Workers-with-static-assets
// model doesn't have Pages' automatic /functions folder routing, so this script has to
// check the path itself: anything under /img/ goes to the caching proxy below,
// everything else falls through to env.ASSETS, which serves the static site (same
// files GitHub Pages serves).

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname.startsWith('/img/')){
      return handleImageProxy(url, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

// Confirmed via testing (checked the actual request VNDB's own site fires): this is
// where VN cover images are served from. Kept as one constant, easy to update if VNDB
// ever changes their CDN domain, rather than scattered through the function below.
const VNDB_IMAGE_HOST = 'https://t.vndb.org';

async function handleImageProxy(url, env, ctx){
  // Everything after "/img/" is treated as the image's own path (e.g. "cv/40/89140.jpg"),
  // never a full URL, so the actual upstream domain never has to appear anywhere in a
  // client-visible request, only inside this function, only on an actual cache miss.
  const key = url.pathname.slice('/img/'.length);

  if(!key){
    return new Response('Missing image path', { status: 400 });
  }

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
  const upstreamUrl = VNDB_IMAGE_HOST + '/' + key;
  const upstream = await fetch(upstreamUrl);
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
