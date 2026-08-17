// The /img/* route: proxies and caches VNDB cover art through R2. Three layers before
// anything reaches R2 or VNDB: the key must match VNDB's real cover-path shape, it must
// belong to a VN actually in the local database (VNDB hosts covers for its whole catalog,
// not just this site's filtered dataset), and cache-miss requests are rate-limited per IP.

import express from 'express';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from './db.js';
import { getClientIp, imageMissAllowed } from './rateLimit.js';

const R2_BUCKET = process.env.R2_BUCKET || 'rvng-covers';
const VNDB_IMAGE_HOST = 'https://t.vndb.org'; // confirmed via testing, not documented anywhere official

// Matches refresh-vndb-db.mjs's imageIdToPath() output exactly, e.g. "cv/39/20339.jpg".
// Without this, /img/* would happily fetch and cache-write whatever path a caller asks
// for, an unauthenticated, unbounded way to make this server copy arbitrary content from
// VNDB into R2 under a key of the caller's choosing.
const COVER_KEY_PATTERN = /^cv\/\d{2}\/\d+\.jpg$/;

// VNDB hosts cover art for its entire catalog, not just the ~65k VNs in this site's own
// filtered dataset, so a key merely matching the right shape isn't enough on its own, it
// still lets someone cache and serve whatever real VNDB image they want under this domain.
// This confirms the key belongs to a VN actually present in the local database before
// anything gets fetched or cached.
const imagePathExistsStmt = db.prepare('SELECT 1 FROM vn WHERE image_path = ? LIMIT 1');
function isKnownCoverKey(key){
  return !!imagePathExistsStmt.get(key);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export const imagesRouter = express.Router();

imagesRouter.get('/img/*', async (req, res) => {
  const key = req.params[0];
  if(!key || !COVER_KEY_PATTERN.test(key) || !isKnownCoverKey(key)){
    return res.status(404).send('Unknown image path');
  }

  try{
    const cached = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.set({
      'Content-Type': cached.ContentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'HIT',
    });
    return cached.Body.pipe(res);
  }catch(err){
    if(err.name !== 'NoSuchKey'){
      console.error('R2 get failed, falling back to upstream:', err.name || err);
    }
  }

  if(!imageMissAllowed(getClientIp(req))){
    return res.status(429).send('Too many uncached image requests, slow down.');
  }

  // the one request per unique image that has to actually reach VNDB
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

  // doesn't block the response on the R2 write, cache just isn't warm for the next request yet
  s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
    .catch(err => console.error('R2 put failed:', err));

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Cache': 'MISS',
  });
  res.send(buffer);
});
