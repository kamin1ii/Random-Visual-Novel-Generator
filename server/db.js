// The shared read only connection on the main thread, imported by both images.js (cover
// key validation) and generate.js (query building, not the queries themselves). The
// actual /api/generate queries run in queryWorker.js, which opens its own separate
// connection per worker thread since a better-sqlite3 handle can't cross that boundary.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';

export const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
