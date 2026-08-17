// refresh-vndb-db.mjs
//
// Downloads the latest VNDB database dump, parses the tables the site actually needs,
// aggregates the raw per user tag votes into a single consensus per (VN, tag) pair,
// derives English release status and release year info from the releases tables, and
// loads everything into the site's local SQLite database. Meant to be run again whenever
// fresh data is wanted, safe to run repeatedly, each run replaces the previous data
// entirely inside one transaction (so a failed run doesn't leave a half loaded database).
//
// This does NOT touch server.js or the live site by itself, it only populates the
// database file. Run this on the VPS itself (it writes straight to the on disk sqlite
// file, no network database round trip).
//
// Setup (run once, on the VPS):
//   1. apt install zstd sqlite3 (sqlite3 CLI not required by this script, useful for
//      poking at the db by hand)
//   2. npm install (installs better-sqlite3, from vnpicker's package.json)
//   3. sqlite3 /opt/rvng/data/randomvn.db < schema.sql   (once, before the first run)
//
// Then, any time you want to refresh:
//   DB_PATH=/opt/rvng/data/randomvn.db node refresh-vndb-db.mjs
// (DB_PATH defaults to /opt/rvng/data/randomvn.db if unset, matching server.js)

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMP_URL = 'https://dl.vndb.org/dump/vndb-db-latest.tar.zst';
const WORK_DIR = path.join(__dirname, 'vndb-dump-work');
const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';

function parseTSV(filePath, label){
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  if(lines[lines.length - 1] === '') lines.pop();
  console.log(`  ${label}: ${lines.length.toLocaleString()} lines to parse`);
  const rows = new Array(lines.length);
  for(let i = 0; i < lines.length; i++){
    rows[i] = lines[i].split('\t').map(f => (f === '\\N' ? null : unescapeTsvField(f)));
    if(i > 0 && i % 200000 === 0) console.log(`    parsed ${i.toLocaleString()}/${lines.length.toLocaleString()}`);
  }
  return rows;
}

// PostgreSQL's plain text COPY/dump format escapes real newlines, tabs, and backslashes
// within a field's own content as these two character sequences, since the file format
// itself uses real newlines and tabs as row/column separators. Without unescaping this,
// a multi paragraph description's real paragraph breaks show up as the literal text
// "\n\n" instead of an actual newline character.
function unescapeTsvField(val){
  return val
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// Turns "cv20339" into "cv/39/20339.jpg", matching the key format server.js/worker.js
// already expect in R2 (folder is the image number's last two digits).
function imageIdToPath(imageId){
  if(!imageId || !imageId.startsWith('cv')) return null;
  const num = imageId.slice(2);
  const folder = num.slice(-2).padStart(2, '0');
  return `cv/${folder}/${num}.jpg`;
}

function stripFormatting(desc){
  if(!desc) return null;
  return desc
    .replace(/\[url=[^\]]*\]/gi, '')
    .replace(/\[\/url\]/gi, '')
    .replace(/\[spoiler\]/gi, '').replace(/\[\/spoiler\]/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    .trim();
}

async function downloadWithProgress(url, destPath){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Download failed: ${res.status}`);
  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;
  let lastPrint = Date.now();

  const fileStream = createWriteStream(destPath);
  const reader = res.body.getReader();
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    fileStream.write(value);
    received += value.length;
    if(Date.now() - lastPrint > 1000){
      const mb = (received / 1024 / 1024).toFixed(1);
      if(totalBytes){
        const pct = ((received / totalBytes) * 100).toFixed(0);
        console.log(`  downloaded ${mb}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB (${pct}%)`);
      } else {
        console.log(`  downloaded ${mb}MB`);
      }
      lastPrint = Date.now();
    }
  }
  fileStream.end();
  await finished(fileStream);
}

// Small hand-rolled concurrency pool, keeps a fixed number of workers in flight instead
// of firing all 65k+ requests at once (would flood both VNDB's image host and this VPS's
// own network) or doing them one at a time (would take hours).
async function runWithConcurrency(items, limit, worker){
  let index = 0;
  let active = 0;
  return new Promise((resolve) => {
    function next(){
      if(index >= items.length && active === 0){ resolve(); return; }
      while(active < limit && index < items.length){
        const item = items[index++];
        active++;
        worker(item).catch(() => {}).finally(() => {
          active--;
          next();
        });
      }
    }
    next();
  });
}

const VNDB_IMAGE_HOST = 'https://t.vndb.org';
const PREWARM_CONCURRENCY = 20;

// Proactively fills R2 with every cover this refresh knows about, checking first so a
// re-run only downloads what's actually missing (most of the catalog won't have changed
// since last time). Visitors then never hit the on-demand fetch-and-cache path in
// server.js for anything already known at refresh time, that path still exists there
// purely as a fallback (a VN VNDB adds after this run, or a download that failed here).
async function prewarmCoverCache(imagePaths){
  if(!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY){
    console.warn('R2 credentials not set in the environment, skipping cover cache prewarm (server.js will still cache covers on demand as visitors request them).');
    return;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const bucket = process.env.R2_BUCKET || 'rvng-covers';

  let done = 0, alreadyCached = 0, downloaded = 0, failed = 0;
  const total = imagePaths.length;

  await runWithConcurrency(imagePaths, PREWARM_CONCURRENCY, async (key) => {
    try{
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      alreadyCached++; // already there, nothing to do
    }catch(err){
      if(err.name !== 'NotFound' && err.name !== 'NoSuchKey'){
        failed++;
        return;
      }
      try{
        const upstream = await fetch(`${VNDB_IMAGE_HOST}/${key}`);
        if(!upstream.ok){ failed++; return; }
        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        if(!contentType.startsWith('image/')){ failed++; return; }
        const buffer = Buffer.from(await upstream.arrayBuffer());
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
        downloaded++;
      }catch(err2){
        failed++;
      }
    }finally{
      done++;
      if(done % 2000 === 0 || done === total){
        console.log(`  prewarm: ${done.toLocaleString()}/${total.toLocaleString()} (${alreadyCached.toLocaleString()} already cached, ${downloaded.toLocaleString()} newly downloaded, ${failed.toLocaleString()} failed)`);
      }
    }
  });

  console.log(`Cover cache prewarm done: ${alreadyCached.toLocaleString()} already cached, ${downloaded.toLocaleString()} newly downloaded, ${failed.toLocaleString()} failed (failures fall back to on-demand caching when a visitor requests them).`);
}

async function main(){
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const localFile = process.argv[2];
  let archivePath;

  if(localFile){
    const resolvedPath = path.isAbsolute(localFile) ? localFile : path.join(process.cwd(), localFile);
    if(!existsSync(resolvedPath)){
      throw new Error(`File not found: ${resolvedPath}`);
    }
    console.log(`Using local file instead of downloading: ${resolvedPath}`);
    archivePath = resolvedPath;
  } else {
    console.log('No local file given, downloading latest VNDB dump...');
    archivePath = path.join(WORK_DIR, 'dump.tar.zst');
    await downloadWithProgress(DUMP_URL, archivePath);
    console.log(`Downloaded, saved to: ${archivePath}`);
  }

  console.log('Extracting needed tables...');
  execSync(`tar --zstd -xf "${archivePath}" -C "${WORK_DIR}" db/vn db/vn_titles db/tags_vn db/tags_parents db/images db/releases db/releases_vn db/releases_titles db/releases_platforms TIMESTAMP`, { stdio: 'inherit' });

  const dumpTimestamp = readFileSync(path.join(WORK_DIR, 'TIMESTAMP'), 'utf-8').trim();
  console.log(`  dump timestamp: ${dumpTimestamp}`);

  console.log('Parsing images (for the explicit-cover flag)...');
  const imageRows = parseTSV(path.join(WORK_DIR, 'db/images'), 'images');
  // id, width, height, c_votecount, c_sexual_avg, c_sexual_stddev, c_violence_avg, c_violence_stddev, c_weight
  const sexualByImageId = new Map();
  for(const r of imageRows){
    const [id, , , , c_sexual_avg] = r;
    if(c_sexual_avg !== null) sexualByImageId.set(id, parseInt(c_sexual_avg, 10) / 100); // raw dump stores *100 versus the live API's 0-2 scale
  }

  console.log('Parsing vn table...');
  const vnRows = parseTSV(path.join(WORK_DIR, 'db/vn'), 'vn');
  const vnById = new Map();
  for(const r of vnRows){
    const [id, image, c_image, olang, votecount, c_rating, , c_length, , lengthCategory, devstatus, , description] = r;
    const resolvedImage = image || c_image; // c_image is a fallback VNDB itself uses when the primary image field is unset, skipping it was silently dropping covers for ~25% of VNs
    vnById.set(id, {
      id,
      image_path: imageIdToPath(resolvedImage),
      sexual: resolvedImage ? (sexualByImageId.get(resolvedImage) ?? null) : null,
      olang,
      votecount: parseInt(votecount, 10) || 0,
      rating: c_rating ? parseInt(c_rating, 10) / 10 : null,
      length: lengthCategory ? parseInt(lengthCategory, 10) : null, // the 1-5 category scale, was previously reading the wrong column entirely
      length_minutes: c_length ? parseInt(c_length, 10) : null, // real minutes value, was previously hardcoded to NULL
      devstatus: devstatus ? parseInt(devstatus, 10) : null,
      description: stripFormatting(description),
      released_year: null,
      has_en_lang: 0,
      platforms: new Set(),
      languages: new Set(),
      has_en_release_complete: 0,
      has_en_release_any: 0,
      has_en_mtl: 0,
    });
  }
  console.log(`  ${vnById.size} Japanese-original VNs kept`);

  console.log('Parsing vn_titles, resolving main titles...');
  const titleRows = parseTSV(path.join(WORK_DIR, 'db/vn_titles'), 'vn_titles');
  for(const r of titleRows){
    const [id, lang, official, title, latin] = r;
    const vn = vnById.get(id);
    if(!vn) continue;
    if(lang === vn.olang && official === 't') vn.title = latin || title;
    if(lang === 'en' && !vn.alttitle && title) vn.alttitle = latin || title;
  }
  for(const vn of vnById.values()){
    if(!vn.title) vn.title = vn.alttitle || vn.id;
  }

  console.log('Parsing and aggregating tags_vn...');
  const tagVoteRows = parseTSV(path.join(WORK_DIR, 'db/tags_vn'), 'tags_vn');
  const tagAgg = new Map();
  for(let i = 0; i < tagVoteRows.length; i++){
    const [, tag, vid, , vote, spoiler, ignore, lie] = tagVoteRows[i];
    if(!vnById.has(vid)) continue;
    if(ignore === 't' || lie === 't') continue;
    const key = `${vid}|${tag}`;
    if(!tagAgg.has(key)) tagAgg.set(key, { voteSum: 0, voteCount: 0, spoilerSum: 0, spoilerCount: 0 });
    const agg = tagAgg.get(key);
    const v = parseFloat(vote);
    if(!isNaN(v)){ agg.voteSum += v; agg.voteCount++; }
    if(spoiler !== null){ agg.spoilerSum += parseInt(spoiler, 10); agg.spoilerCount++; }
    if(i > 0 && i % 500000 === 0) console.log(`  aggregated ${i.toLocaleString()}/${tagVoteRows.length.toLocaleString()}`);
  }

  console.log('Parsing tags_parents (tag hierarchy)...');
  const tagParentRows = parseTSV(path.join(WORK_DIR, 'db/tags_parents'), 'tags_parents');
  // id, parent, main
  const directParents = new Map(); // child raw tag id -> Set of direct parent raw tag ids
  for(const r of tagParentRows){
    const [id, parent] = r;
    if(!directParents.has(id)) directParents.set(id, new Set());
    directParents.get(id).add(parent);
  }
  // Tags form a DAG (a tag can have more than one parent), so this walks every ancestor,
  // not just the immediate parent, memoized since the same tag gets asked about repeatedly
  // across many VNs.
  const ancestorCache = new Map();
  function getAncestors(tagId){
    if(ancestorCache.has(tagId)) return ancestorCache.get(tagId);
    const result = new Set();
    ancestorCache.set(tagId, result); // guards against cycles, shouldn't exist but cheap insurance
    const parents = directParents.get(tagId);
    if(parents){
      for(const p of parents){
        if(result.has(p)) continue;
        result.add(p);
        for(const anc of getAncestors(p)) result.add(anc);
      }
    }
    return result;
  }

  // VNDB's live tag search also matches any ancestor of a directly-applied tag, filtering
  // for "Fantasy" matches a VN only tagged with a more specific child like "Fictional
  // Beings" too, it doesn't require a direct vote on "Fantasy" itself. Without this, local
  // results systematically undercount the live API for any tag that has children, worse
  // for broad parent tags. Every ancestor gets an implicit entry alongside the direct one,
  // deduped against direct entries by keeping whichever spoiler level is least restrictive.
  const finalByKey = new Map(); // "vid|bareTagId" -> spoiler
  for(const [key, agg] of tagAgg){
    if(agg.voteCount === 0) continue;
    const avgVote = agg.voteSum / agg.voteCount;
    if(avgVote <= 0) continue;
    const [vid, tag] = key.split('|');
    const avgSpoiler = agg.spoilerCount ? Math.round(agg.spoilerSum / agg.spoilerCount) : 0;
    const spoiler = Math.min(2, Math.max(0, avgSpoiler));

    for(const rawId of [tag, ...getAncestors(tag)]){
      // strips the leading "g" so this matches tags.json's bare integer id format exactly,
      // the same mismatch already found once in render.js, fixed here at the source instead
      const bareTagId = rawId.replace(/^\D+/, '');
      const dedupeKey = `${vid}|${bareTagId}`;
      const existing = finalByKey.get(dedupeKey);
      if(existing === undefined || spoiler < existing) finalByKey.set(dedupeKey, spoiler);
    }
  }

  const vnTags = [];
  for(const [key, spoiler] of finalByKey){
    const [vn_id, tag_id] = key.split('|');
    vnTags.push({ vn_id, tag_id, spoiler });
  }
  console.log(`  ${vnTags.length} (vn, tag) pairs kept after aggregation (direct + inherited via tag hierarchy)`);

  // --- Releases: derive release year and English-release-status flags per VN ---
  console.log('Parsing releases...');
  const releaseRows = parseTSV(path.join(WORK_DIR, 'db/releases'), 'releases');
  // id, gtin, olang, released, voiced, reso_x, reso_y, minage, ani_*, has_ero, patch, freeware, uncensored, official, catalog, notes, engine
  const releaseYearById = new Map(); // release id -> year (integer) or null
  for(const r of releaseRows){
    const [id, , , released] = r;
    if(released && /^\d{8}$/.test(released)){
      releaseYearById.set(id, Math.floor(parseInt(released, 10) / 10000));
    } else {
      releaseYearById.set(id, null);
    }
  }

  console.log('Parsing releases_titles (English + MTL info, and all languages, per release)...');
  const relTitleRows = parseTSV(path.join(WORK_DIR, 'db/releases_titles'), 'releases_titles');
  // id, lang, mtl, title, latin
  const englishReleaseInfo = new Map(); // release id -> { hasEn: bool, hasEnNonMtl: bool, hasMtl: bool }
  const languagesByRelease = new Map(); // release id -> Set of all language codes present
  for(const r of relTitleRows){
    const [id, lang, mtl] = r;

    if(!languagesByRelease.has(id)) languagesByRelease.set(id, new Set());
    languagesByRelease.get(id).add(lang);

    if(lang !== 'en') continue;
    if(!englishReleaseInfo.has(id)) englishReleaseInfo.set(id, { hasEn: false, hasEnNonMtl: false, hasMtl: false });
    const info = englishReleaseInfo.get(id);
    info.hasEn = true;
    if(mtl === 'f') info.hasEnNonMtl = true;
    if(mtl === 't') info.hasMtl = true;
  }

  console.log('Parsing releases_platforms...');
  const relPlatformRows = parseTSV(path.join(WORK_DIR, 'db/releases_platforms'), 'releases_platforms');
  // id, platform
  const platformsByRelease = new Map(); // release id -> Set of platform codes
  for(const r of relPlatformRows){
    const [id, platform] = r;
    if(!platformsByRelease.has(id)) platformsByRelease.set(id, new Set());
    platformsByRelease.get(id).add(platform);
  }

  console.log('Parsing releases_vn, deriving per-VN release flags...');
  const relVnRows = parseTSV(path.join(WORK_DIR, 'db/releases_vn'), 'releases_vn');
  // id, vid, rtype
  for(const r of relVnRows){
    const [relId, vid, rtype] = r;
    const vn = vnById.get(vid);
    if(!vn) continue;

    const year = releaseYearById.get(relId);
    if(year && (vn.released_year === null || year < vn.released_year)) vn.released_year = year;

    const relLanguages = languagesByRelease.get(relId);
    if(relLanguages) for(const lang of relLanguages) vn.languages.add(lang);

    const relPlatforms = platformsByRelease.get(relId);
    if(relPlatforms) for(const platform of relPlatforms) vn.platforms.add(platform);

    const enInfo = englishReleaseInfo.get(relId);
    if(enInfo){
      if(enInfo.hasEnNonMtl) vn.has_en_lang = 1; // matches the live API's vn-level "languages" field, which excludes MTL
      if(enInfo.hasMtl) vn.has_en_mtl = 1;
      if(enInfo.hasEn){
        vn.has_en_release_any = 1;
        if(rtype === 'complete') vn.has_en_release_complete = 1;
      }
    }
  }
  console.log('  release-derived flags computed');

  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const vnColumns = 'id, title, alttitle, image_path, sexual, olang, votecount, rating, length, length_minutes, devstatus, description, has_description, released_year, has_en_lang, has_en_release_complete, has_en_release_any, has_en_mtl, platforms, languages, rand_key';
  const insertVn = db.prepare(`INSERT INTO vn (${vnColumns}) VALUES (${vnColumns.split(', ').map(() => '?').join(',')})`);
  const insertTag = db.prepare('INSERT INTO vn_tags (vn_id, tag_id, spoiler) VALUES (?, ?, ?)');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

  const loadAll = db.transaction(() => {
    console.log('Clearing existing data...');
    db.exec('DELETE FROM vn; DELETE FROM vn_tags;');

    console.log('Loading vn table...');
    let vnLoaded = 0;
    for(const vn of vnById.values()){
      insertVn.run(
        vn.id, vn.title, vn.alttitle, vn.image_path, vn.sexual, vn.olang, vn.votecount,
        vn.rating, vn.length, vn.length_minutes, vn.devstatus, vn.description,
        vn.description ? 1 : 0, vn.released_year, vn.has_en_lang, vn.has_en_release_complete,
        vn.has_en_release_any, vn.has_en_mtl, JSON.stringify(Array.from(vn.platforms)),
        JSON.stringify(Array.from(vn.languages)), Math.random(),
      );
      vnLoaded++;
    }
    console.log(`  ${vnLoaded} vn rows loaded`);

    console.log('Loading vn_tags table...');
    for(const t of vnTags){
      insertTag.run(t.vn_id, t.tag_id, t.spoiler);
    }
    console.log(`  ${vnTags.length} vn_tags rows loaded`);

    setMeta.run('dump_timestamp', dumpTimestamp);
  });

  loadAll();
  db.close();

  console.log('Prewarming R2 cover cache...');
  const imagePaths = [...new Set(Array.from(vnById.values()).map(vn => vn.image_path).filter(Boolean))];
  console.log(`  ${imagePaths.length.toLocaleString()} unique cover images to check`);
  await prewarmCoverCache(imagePaths);

  console.log('Done. Cleaning up temp files...');
  rmSync(WORK_DIR, { recursive: true, force: true });
  console.log('Refresh complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
