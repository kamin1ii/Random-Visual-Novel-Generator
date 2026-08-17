# Random VN List Generator

A random visual novel list generator and browser built on data from [VNDB](https://vndb.org). Set filters, generate a randomized list of matching titles, and browse the results one at a time with cover art, stats, tags, and a synopsis.

**Site:** https://randomvn.org

![Screenshot](https://i.postimg.cc/1zVgs299/randomvnss.png)

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

Vanilla HTML, CSS, and ES modules, served from [`public/`](public).

The backend ([`server/`](server)) is a Node/Express app. [`index.js`](server/index.js) wires everything together and serves `public/`, [`images.js`](server/images.js) serves VN cover art from a local mirror of VNDB's own images (falling back to fetching and caching anything not in the mirror yet), [`generate.js`](server/generate.js) answers `/api/generate` and `/api/db-info` against a local SQLite database, and [`rateLimit.js`](server/rateLimit.js) protects both against abuse. Both the database ([`db/schema.sql`](db/schema.sql)) and the cover image mirror are populated by [`db/refresh-vndb-db.mjs`](db/refresh-vndb-db.mjs), from VNDB's public data dump and VNDB's own rsync image feed respectively, rather than querying VNDB's live API for every request.

[`legacy-cloudflare/`](legacy-cloudflare) is kept for reference, an earlier version of this project ran as a Cloudflare Worker with a D1 database instead of the current self-hosted setup.
