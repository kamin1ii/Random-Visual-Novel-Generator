// The /img/* route: serves VN cover art from a local mirror of VNDB's cover images
// (synced by db/refresh-vndb-db.mjs from VNDB's own rsync feed), falling back to an
// on-demand fetch for anything not in the mirror yet, either a VN added after the last
// refresh or, more commonly, a cover VNDB has since changed to a different image than
// what our last refresh captured (the frontend's VNDB-live-API mode shows VNDB's current
// data directly, so its image URLs are only ever as stale as VNDB's live cover, not our
// periodic snapshot). That fetch gets cached to disk too, so it's only ever fetched once.
//
// Two checks before anything is served: the key must match VNDB's real cover-path shape,
// and cache-miss fallback requests are rate-limited per IP. There's deliberately no check
// that the key belongs to a VN in our own database, that would reject real, current VNDB
// covers whenever they've drifted from our last snapshot, exactly the live-API mode's
// reason to exist. Serving any real VNDB cover matching the filename shape is an
// acceptable trade here: images are local disk now, not metered storage, cache misses are
// already rate-limited, and everything servable is still real VNDB content, never
// caller-supplied bytes.

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { getClientIp, imageMissAllowed } from './rateLimit.js';

// Purely for the console log below, has no effect on what gets served. The image path
// alone isn't a reliable way to find the VN on a miss, that's exactly the case when the
// miss is caused by our database being stale, so the frontend passes the VN id it already
// has instead of this trying to reverse-lookup a possibly-stale image_path.
const titleByIdStmt = db.prepare('SELECT title FROM vn WHERE id = ?');

const COVERS_DIR = process.env.COVERS_DIR || '/opt/rvng/data/covers';
const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

// Matches refresh-vndb-db.mjs's imageIdToPath() output exactly, e.g. "cv/39/20339.jpg",
// and VNDB's own rsync mirror layout. Without this, /img/* would happily fetch and cache
// whatever path a caller asks for, an unauthenticated way to make this server copy
// arbitrary content from VNDB under a key of the caller's choosing (still real VNDB
// content only, the host is hardcoded, but still worth constraining to the one real shape).
const COVER_KEY_PATTERN = /^cv\/\d{2}\/\d+\.jpg$/;

export const imagesRouter = express.Router();

imagesRouter.get('/img/*', async (req, res) => {
  const key = req.params[0];
  if(!key || !COVER_KEY_PATTERN.test(key)){
    return res.status(404).send('Unknown image path');
  }

  const localPath = path.join(COVERS_DIR, key);

  try{
    const buffer = await fsp.readFile(localPath);
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'HIT',
    });
    return res.send(buffer);
  }catch(err){
    if(err.code !== 'ENOENT'){
      console.error('Local cover read failed, falling back to upstream:', err.code || err);
    }
  }

  if(!imageMissAllowed(getClientIp(req))){
    return res.status(429).send('Too many uncached image requests, slow down.');
  }

  const vnId = typeof req.query.vn === 'string' ? req.query.vn : null;
  const vnTitle = vnId ? titleByIdStmt.get(vnId)?.title : null;
  const label = vnTitle ? `${vnTitle} (${vnId})` : vnId ? vnId : key;
  console.log(`cover missing locally: ${label}, fetching from VNDB...`);

  // the one request per unique image that has to actually reach VNDB, for anything the
  // last refresh's mirror sync didn't already have
  let upstream;
  try{
    upstream = await fetch(`${VNDB_IMAGE_HOST}/${key}`);
  }catch(err){
    console.error('Upstream fetch errored:', err);
    return res.status(502).send('Upstream fetch failed');
  }
  if(!upstream.ok){
    return res.status(upstream.status).send('Upstream fetch failed');
  }

  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if(!contentType.startsWith('image/')){
    // defense in depth, the key pattern above already makes this practically unreachable
    console.error('Upstream returned a non-image content type, refusing to cache:', contentType);
    return res.status(502).send('Unexpected upstream content type');
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());

  // doesn't block the response on the disk write, cache just isn't warm for the next request yet
  fsp.mkdir(path.dirname(localPath), { recursive: true })
    .then(() => fsp.writeFile(localPath, buffer))
    .then(() => console.log(`cover cached: ${label}`))
    .catch(err => console.error('Local cover cache write failed:', err));

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Cache': 'MISS',
  });
  res.send(buffer);
});
