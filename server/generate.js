// /api/generate and /api/db-info, the actual query engine. Filters get turned into a
// parameterized WHERE clause (whereClause.js), matched VNs are picked via a true random
// indexed seek (rand_key), and tags for the returned VNs are fetched separately. The
// actual SQLite work for /api/generate happens in a worker thread pool (workerPool.js,
// queryWorker.js), not on this thread, so concurrent requests run in parallel across the
// machine's other cores instead of queuing behind each other.

import express from 'express';
import { db } from './db.js';
import { rateLimitMiddleware } from './rateLimit.js';
import { runQuery } from './workerPool.js';
import { buildWhereClause } from './whereClause.js';

export const generateRouter = express.Router();

generateRouter.get('/api/db-info', (req, res) => {
  try{
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dump_timestamp'").get();
    res.json({ dumpTimestamp: row ? row.value : null });
  }catch(err){
    res.status(500).json({ dumpTimestamp: null, error: 'lookup failed' });
  }
});

generateRouter.post('/api/generate', rateLimitMiddleware, express.json(), async (req, res) => {
  const body = req.body || {};
  const listSize = Math.min(300, Math.max(1, parseInt(body.listSize, 10) || 50));

  let whereClause, params;
  try{
    ({ where: whereClause, params } = buildWhereClause(body));
  }catch(err){
    return res.status(400).json({ error: 'Invalid filters' });
  }

  try{
    const { count, results, cacheHit, queryMs } = await runQuery(whereClause, params, listSize);
    console.log(`generate: ${queryMs}ms total (count ${cacheHit ? 'HIT' : 'MISS'}), ${count} matches, ${results.length} returned`);
    res.json({ count, results, debug: { cacheHit, queryMs } });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Database query failed', detail: String(err) });
  }
});
