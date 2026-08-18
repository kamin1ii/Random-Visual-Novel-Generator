# Random VN List Generator

A random visual novel list generator and browser built on data from [VNDB](https://vndb.org). Set filters, generate a randomized list of matching titles, and browse the results one at a time with cover art, stats, tags, and a synopsis.

**Site:** https://randomvn.org

![Screenshot](https://i.postimg.cc/SNVszmPf/Untitled.png)

## Features

- Generates a randomized list (50 to 300 titles) from all matching results, with a new random subset and browsing order on every generate
- Filter by minimum score, minimum vote count, and release year range
- Filter by original language (Japanese) and English release status, including partial patches and machine translations
- Filter by playtime length
- Include and exclude specific VNDB tags, each with independent AND/OR match modes, with autocomplete search.
- Browse one title at a time by clicking the card, using the Prev/Next buttons, or the left/right arrow keys
- Explicit cover art is blurred by default and revealing it asks for confirmation first, with an optional "don't ask again" preference that persists across visits that can be turned back on anytime
- Content tags are capped to a short preview per title with an option to expand the rest in place, plus a link to the full tag list on VNDB for anything filtered out of that preview
- Responsive layout for narrower screens
- Cover art preloads for nearby entries in the list so navigation feels instant
- Results are pulled from a self-hosted copy of VNDB's own data by default, kept in sync with periodic refreshes, with an option to query VNDB's live API directly instead

## How it works

The project restructures VNDB's own data rather than querying VNDB for every generation. VNDB's dump has their Postgres database in plain text COPY format, so a refresh script parses the relevant tables out of that, aggregates things like per user tag votes into one consensus per VN and tag, and loads the result into a much smaller SQLite database built just for this site's queries.

Each visual novel gets a random value assigned once, at import time, stored in an indexed column. Generating a list does an indexed seek starting from a random point in that column rather than scanning or sorting the whole table, so picking a random matching subset stays fast even as the dataset grows. Cover images are cached separately on disk, and the server handles both generation and image requests.

## Data

Visual novel data is sourced from [VNDB](https://vndb.org/).
The database was imported from a VNDB database dump. VNDB's data and content remain subject to their respective licenses and terms.

### Requirements

- Node.js 18+ 
- npm
- `sqlite3` CLI (used once to create the database from the schema)
- `rsync` and `zstd` (used by `db/refresh-vndb-db.mjs` to unpack VNDB's dump and mirror cover art)
- A C/C++ build toolchain (e.g. `build-essential` on Linux, Xcode Command Line Tools on macOS) only needed if `npm install` can't fetch a prebuilt binary for `better-sqlite3` on your platform

### Installation

```bash
git clone https://github.com/kamin1ii/Random-Visual-Novel-Generator.git
cd Random-Visual-Novel-Generator
npm install
```

Note first. `db/refresh-vndb-db.mjs` was written for the production VPS, run as root over SSH. It ends by running `chown -R rvng:rvng` on `COVERS_DIR` so before running it locally, edit that line in `db/refresh-vndb-db.mjs` to your own username instead of `rvng`, or just remove the line entirely since on a single user local setup the files are already owned by whoever ran the script.

Set up the database. `server/db.js` opens `DB_PATH` with `fileMustExist` true as soon as the server starts, so the file has to exist first or `npm start` crashes immediately. It doesn't need any data loaded at that point, just the schema applied.

1. Create the database from the schema. The directory containing `DB_PATH` has to exist first, neither the `sqlite3` CLI nor `better-sqlite3` will create a missing parent directory on their own.

   ```bash
   mkdir -p "$(dirname /path/to/randomvn.db)"
   sqlite3 /path/to/randomvn.db < db/schema.sql
   ```

2. Populate it from a VNDB dump.

   ```bash
   DB_PATH=/path/to/randomvn.db node db/refresh-vndb-db.mjs
   ```

   This downloads VNDB's latest database and tag dumps, parses everything the site needs (titles, tags, release and language info, etc), and loads it into the database in a single transaction. It also mirrors VNDB's cover image archive into `COVERS_DIR` via `rsync`, the first run downloads the full set, and re-running the script later only transfers what changed. See the note above about the `chown` line before running this.

3. Start the server, pointing it at the same database.

   ```bash
   DB_PATH=/path/to/randomvn.db npm start
   ```

#### Configuration

The server and refresh script are both configured through environment variables, all optional:

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | server |
| `DB_PATH` | `/opt/rvng/data/randomvn.db` | server, refresh script |
| `COVERS_DIR` | `/opt/rvng/data/covers` | server, refresh script |
| `QUERY_WORKER_POOL_SIZE` | `2` | server |

The server always binds to `127.0.0.1`, so for local development it's reachable at `http://localhost:3000` once started; in production it sits behind a reverse proxy.
