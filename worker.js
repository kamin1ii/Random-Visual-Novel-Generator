// Single entry point for the whole Worker. Workers with static assets doesn't have
// Pages' automatic /functions routing, so this checks the path itself. /img/ goes to
// the caching proxy below, everything else falls through to env.ASSETS (the static site).

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    // Done in code rather than a Cloudflare Redirect Rule. Redirect Rules can silently
    // fail to fire when their target is itself a Workers Custom Domain, this way is
    // guaranteed to run since it's the first thing the Worker does.
    if(url.hostname === 'www.randomvn.org'){
      url.hostname = 'randomvn.org';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if(url.pathname.startsWith('/img/')){
      return handleImageProxy(url, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

async function handleImageProxy(url, env, ctx){
  // path only, never a full URL, so the upstream domain never appears in a client visible request
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
        'X-Cache': 'HIT',
      },
    });
  }

  // the one request per unique image that has to actually reach VNDB
  const upstreamUrl = VNDB_IMAGE_HOST + '/' + key;
  const upstream = await fetch(upstreamUrl);
  if(!upstream.ok){
    return new Response('Upstream fetch failed', { status: upstream.status });
  }

  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await upstream.arrayBuffer();

  // returns immediately, doesn't wait on the R2 write, cache just isn't warm for the next request yet
  ctx.waitUntil(
    env.COVERS_BUCKET.put(key, buffer, {
      httpMetadata: { contentType },
    })
  );

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'MISS',
    },
  });
}
