// The /img/* route: serves VN cover art from a local mirror of VNDB's cover images
// (synced by db/refresh-vndb-db.mjs from VNDB's own rsync feed), falling back to an
// on-demand fetch for anything not in the mirror yet (a VN added after the last refresh),
// caching that fetch to disk too so it's only ever fetched once. Three checks before
// anything is served: the key must match VNDB's real cover-path shape, it must belong to
// a VN actually in the local database (VNDB's mirror covers its whole catalog, not just
// this site's filtered dataset), and cache-miss fallback requests are rate-limited per IP.

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { getClientIp, imageMissAllowed } from './rateLimit.js';

const COVERS_DIR = process.env.COVERS_DIR || '/opt/rvng/data/covers';
const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

// Matches refresh-vndb-db.mjs's imageIdToPath() output exactly, e.g. "cv/39/20339.jpg",
// and VNDB's own rsync mirror layout. Without this, /img/* would happily fetch and cache
// whatever path a caller asks for, an unauthenticated, unbounded way to make this server
// copy arbitrary content from VNDB under a key of the caller's choosing.
const COVER_KEY_PATTERN = /^cv\/\d{2}\/\d+\.jpg$/;

// VNDB's image mirror covers its entire catalog, not just the ~65k VNs in this site's own
// filtered dataset, so a key merely matching the right shape isn't enough on its own, it
// still lets someone cache and serve whatever real VNDB image they want under this domain.
// This confirms the key belongs to a VN actually present in the local database before
// anything gets read, fetched, or cached.
const imagePathExistsStmt = db.prepare('SELECT 1 FROM vn WHERE image_path = ? LIMIT 1');
function isKnownCoverKey(key){
  return !!imagePathExistsStmt.get(key);
}

export const imagesRouter = express.Router();

imagesRouter.get('/img/*', async (req, res) => {
  const key = req.params[0];
  if(!key || !COVER_KEY_PATTERN.test(key) || !isKnownCoverKey(key)){
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
    .catch(err => console.error('Local cover cache write failed:', err));

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Cache': 'MISS',
  });
  res.send(buffer);
});
