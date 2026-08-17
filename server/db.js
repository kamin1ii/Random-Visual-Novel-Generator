// The one shared database connection, imported by both images.js (cover-key validation)
// and generate.js (the actual queries), so there's a single read-only handle rather than
// each module opening its own.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';

export const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
