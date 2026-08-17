# Random VN List Generator

A random visual novel generator and browser built on data from [VNDB](https://vndb.org). Set filters, generate a randomized list of matching titles, and browse the results one at a time with cover art, stats, tags, and a synopsis.

**Site:** https://randomvn.org

![Screenshot](https://i.postimg.cc/Bv9qV1Vc/RVNGupdate.png)

## Features

- Filter by minimum score, minimum vote count, and release year range
- Filter by original language (Japanese) and English release status, including partial patches and machine translations
- Filter by playtime length
- Include and exclude specific VNDB tags, each with independent AND/OR match modes, using a debounced autocomplete search against the VNDB tag database. Filtering by a general tag also matches titles only tagged with a more specific child of it, the same tag hierarchy VNDB's own search uses
- Generates a randomized list (50 to 300 titles) from all matching results, with a new random subset and browsing order on every generate
- Browse one title at a time by clicking the card, using the Prev/Next buttons, or the left/right arrow keys
- Explicit cover art is blurred by default and revealing it asks for confirmation first, with an optional "don't ask again" preference that persists across visits that can be turned back on anytime
- Content tags are capped to a short preview per title with an option to expand the rest in place, plus a link to the full tag list on VNDB for anything filtered out of that preview
- Responsive layout for narrower screens
- Cover art preloads for nearby entries in the list so navigation feels instant
- Results are pulled from a self-hosted copy of VNDB's own data by default, kept in sync with periodic refreshes, with an option to query VNDB's live API directly instead

## Stack

Vanilla HTML, CSS, and ES modules on the frontend, no build step or framework.

The backend ([`server.js`](server.js)) is a Node/Express app. It serves the static site, proxies and caches VNDB cover art through Cloudflare R2, and answers `/api/generate` against a local SQLite database ([`schema.sql`](schema.sql)) populated from VNDB's public data dump ([`refresh-vndb-db.mjs`](refresh-vndb-db.mjs)), rather than querying VNDB's live API for every request.

`worker.js` and `wrangler.toml` are kept in the repo for reference, an earlier version of this project ran as a Cloudflare Worker with a D1 database instead of the current self-hosted setup.
