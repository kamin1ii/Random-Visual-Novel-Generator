// Entry point. App setup, middleware, mounts the route modules, serves the static site,
// and listens. Node/Express replacement for legacy-cloudflare/worker.js, used now that the
// site is hosted directly on the VPS instead of Cloudflare Workers. worker.js is left in
// place as a rollback path back to Cloudflare Workers/Pages.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imagesRouter } from './images.js';
import { generateRouter } from './generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Caddy is a trusted local reverse proxy in front of this app

app.use((req, res, next) => {
  if(req.hostname === 'www.randomvn.org'){
    return res.redirect(301, `https://randomvn.org${req.originalUrl}`);
  }
  next();
});

app.use(imagesRouter);
app.use(generateRouter);

// Only public/ is ever reachable from here, server code and database tooling live
// outside it entirely, so there's nothing to deny-list.
app.use(express.static(PUBLIC_DIR));

// Must be declared last, and keep all four params so Express recognizes it as an error handler.
app.use((err, req, res, next) => {
  if(err && err.type === 'entity.parse.failed'){
    return res.status(400).json({ error: 'Invalid request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`rvng server listening on 127.0.0.1:${PORT}`);
});
