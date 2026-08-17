// Pool of worker threads that run the actual /api/generate SQLite queries (queryWorker.js).
// better-sqlite3 calls are synchronous, so without this every request queues behind
// Node's single main thread no matter how many CPU cores the machine has. Each worker
// opens its own read only database connection, SQLite allows any number of concurrent
// readers against the same file.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'queryWorker.js');

// Leaves at least one core free for the main thread itself (accepting connections,
// routing, the image proxy's fetches) and whatever the OS and reverse proxy need,
// instead of claiming every core for query execution alone.
const POOL_SIZE = parseInt(process.env.QUERY_WORKER_POOL_SIZE, 10) || 2;

const workers = [];
const pending = new Map(); // job id -> { resolve, reject, worker }
const queue = []; // jobs waiting for a free worker

function spawnWorker(){
  const worker = new Worker(WORKER_PATH);
  worker.busy = false;

  worker.on('message', (msg) => {
    const job = pending.get(msg.id);
    if(!job) return;
    pending.delete(msg.id);
    worker.busy = false;
    if(msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg);
    dispatchNext();
  });

  worker.on('error', (err) => {
    console.error('query worker error:', err);
    for(const [id, job] of pending){
      if(job.worker === worker){
        pending.delete(id);
        job.reject(err);
      }
    }
    const idx = workers.indexOf(worker);
    if(idx !== -1) workers[idx] = spawnWorker();
    dispatchNext();
  });

  return worker;
}

for(let i = 0; i < POOL_SIZE; i++){
  workers.push(spawnWorker());
}

function dispatchNext(){
  if(!queue.length) return;
  const freeWorker = workers.find(w => !w.busy);
  if(!freeWorker) return;
  const job = queue.shift();
  freeWorker.busy = true;
  pending.set(job.id, { resolve: job.resolve, reject: job.reject, worker: freeWorker });
  freeWorker.postMessage({ id: job.id, whereClause: job.whereClause, params: job.params, listSize: job.listSize });
}

export function runQuery(whereClause, params, listSize){
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    queue.push({ id, whereClause, params, listSize, resolve, reject });
    dispatchNext();
  });
}
