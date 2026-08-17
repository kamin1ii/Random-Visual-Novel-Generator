// refresh-vndb-db.mjs
//
// Downloads the latest VNDB database dump, parses the tables the site actually needs,
// aggregates the raw per-user tag votes into a single consensus per (VN, tag) pair,
// derives English-release-status and release-year info from the releases tables, and
// loads everything into the site's local SQLite database. Meant to be re-run whenever
// you want fresh data, safe to run repeatedly, each run replaces the previous data
// entirely inside one transaction (so a failed run doesn't leave a half-loaded database).
//
// This does NOT touch server.js or the live site by itself, it only populates the
// database file. Run this on the VPS itself (it writes straight to the on-disk sqlite
// file, no network database round trip).
//
// Setup (run once, on the VPS):
//   1. apt install zstd sqlite3 rsync (sqlite3 CLI not required by this script, useful
//      for poking at the db by hand)
//   2. npm install (installs better-sqlite3, from vnpicker's package.json)
//   3. sqlite3 /opt/rvng/data/randomvn.db < schema.sql   (once, before the first run)
//
// Then, any time you want to refresh:
//   DB_PATH=/opt/rvng/data/randomvn.db node refresh-vndb-db.mjs
// (DB_PATH defaults to /opt/rvng/data/randomvn.db if unset, matching server.js)
//
// main() below is the pipeline's table of contents, in the exact order it runs, every
// step always runs and always in this order, it's one linear job rather than independent
// pieces, so the actual parsing/loading logic is kept in named functions in this same
// file rather than split across modules.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMP_URL = 'https://dl.vndb.org/dump/vndb-db-latest.tar.zst';
const TAGS_DUMP_URL = 'https://dl.vndb.org/dump/vndb-tags-latest.json.gz';
const WORK_DIR = path.join(__dirname, 'vndb-dump-work');
// Persists across runs (unlike WORK_DIR, wiped every run). VNDB only rebuilds these dumps
// once a day (~08:00 GMT), the "latest" URLs 307-redirect to a dated filename each time
// (vndb-db-2026-08-17.tar.zst), so re-running this script more than once on the same day,
// as happens often while chasing down a data bug, doesn't need to pull the ~180MB archive
// again for identical content, just resolve the redirect (a HEAD request) and reuse the
// file already sitting here if its name matches.
const DUMP_CACHE_DIR = path.join(__dirname, 'dump-cache');
const DB_PATH = process.env.DB_PATH || '/opt/rvng/data/randomvn.db';
const COVERS_DIR = process.env.COVERS_DIR || '/opt/rvng/data/covers';
const PUBLIC_TAGS_PATH = path.join(__dirname, '..', 'public', 'tags.json');
const VNDB_RSYNC_COVERS = 'rsync://dl.vndb.org/vndb-img/cv/';

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

// PostgreSQL's plain-text COPY/dump format escapes real newlines, tabs, and backslashes
// within a field's own content as these two-character sequences, since the file format
// itself uses real newlines and tabs as row/column separators. Without unescaping this,
// a multi-paragraph description's real paragraph breaks show up as the literal text
// "\n\n" instead of an actual newline character.
function unescapeTsvField(val){
  return val
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// Turns "cv20339" into "cv/39/20339.jpg", matching both the local cover mirror's layout
// and the key format server.js expects (folder is the image number's last two digits).
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

// Mirrors VNDB's own cover-image rsync feed locally, this is the tool VNDB explicitly
// documents for bulk/incremental syncing ("prefer incremental updates over redownloading
// a full copy"), rsync's own diffing means a re-run only transfers what actually changed
// instead of tens of thousands of individual HTTP requests. --del removes local files
// VNDB has since removed, keeping the mirror exact. server.js's /img/* route still has an
// on-demand fetch-and-cache fallback for anything this sync doesn't have yet (a VN VNDB
// adds after this run), that's the safety net, not the primary path.
function syncCoverImages(){
  console.log('Syncing cover images from VNDB\'s rsync mirror...');
  const target = path.join(COVERS_DIR, 'cv') + '/';
  mkdirSync(target, { recursive: true });
  execSync(`rsync -rt --del --info=progress2 ${VNDB_RSYNC_COVERS} "${target}"`, { stdio: 'inherit' });
  // This runs as root over SSH, but the live server runs as the unprivileged rvng user and
  // needs write access here too, not just read, it's also where /img/*'s on-demand
  // fetch-and-cache fallback writes newly-fetched covers. chown rather than a world-writable
  // chmod, so only the actual app user gets write access, not literally everyone.
  execSync(`chown -R rvng:rvng "${COVERS_DIR}"`);
  console.log('  cover image sync complete.');
}

// public/tags.json is the client-side tag name/search dump (render.js resolves vn_tags'
// bare ids against it, tagPicker.js searches it for the include/exclude pickers), separate
// from the main VNDB dump above and small enough (a few hundred KB) to just re-fetch
// whole every run rather than diffing. Without this running alongside the main refresh,
// tags.json silently drifts behind the VN data it's meant to label: any tag VNDB adds (or
// a VN gets newly tagged with) after tags.json was last built resolves to "Unknown tag"
// client-side even though the VN's own row correctly has that tag id.
// meta:true entries are category-header rows ("Theme", "Sexual Content" as a group), not
// real tags any VN is ever tagged with, filtered out the same way the original one-time
// snapshot this replaces already did. Returns the excluded ids too, buildVnTagsWithHierarchy
// below needs that same set to stop them from being stored against VNs in the first place.
async function syncTagNames(){
  console.log('Downloading latest VNDB tag list...');
  const res = await fetch(TAGS_DUMP_URL);
  if(!res.ok) throw new Error(`Tag list download failed: ${res.status}`);
  const gzipped = Buffer.from(await res.arrayBuffer());
  const allTags = JSON.parse(gunzipSync(gzipped).toString('utf-8'));
  const metaTagIds = new Set(allTags.filter(t => t.meta).map(t => t.id));
  const tags = allTags
    .filter(t => !t.meta)
    .map(t => ({ id: t.id, name: t.name, category: t.cat, aliases: t.aliases }));
  writeFileSync(PUBLIC_TAGS_PATH, JSON.stringify(tags));
  console.log(`  ${tags.length} tags written to ${PUBLIC_TAGS_PATH} (${metaTagIds.size} meta/category-header tags excluded)`);
  return metaTagIds;
}

// Either uses the local file given as argv[2], or downloads the latest dump fresh.
async function resolveArchivePath(){
  const localFile = process.argv[2];
  if(localFile){
    const resolvedPath = path.isAbsolute(localFile) ? localFile : path.join(process.cwd(), localFile);
    if(!existsSync(resolvedPath)){
      throw new Error(`File not found: ${resolvedPath}`);
    }
    console.log(`Using local file instead of downloading: ${resolvedPath}`);
    return resolvedPath;
  }

  mkdirSync(DUMP_CACHE_DIR, { recursive: true });
  console.log('Checking for today\'s VNDB dump...');
  const headRes = await fetch(DUMP_URL, { method: 'HEAD' });
  const filename = new URL(headRes.url).pathname.split('/').pop();
  const cachedPath = path.join(DUMP_CACHE_DIR, filename);

  if(existsSync(cachedPath)){
    console.log(`Already have today's dump cached, reusing it: ${cachedPath}`);
    return cachedPath;
  }

  console.log(`Not cached, downloading (${filename})...`);
  await downloadWithProgress(headRes.url, cachedPath);
  console.log(`Downloaded, saved to: ${cachedPath}`);

  // Yesterday's cached dump is never needed again once today's is in hand, remove it
  // rather than letting this directory grow by ~180MB every day.
  for(const f of readdirSync(DUMP_CACHE_DIR)){
    if(f !== filename) rmSync(path.join(DUMP_CACHE_DIR, f));
  }

  return cachedPath;
}

// Unpacks just the tables this site needs, returns the dump's own timestamp.
function extractDumpTables(archivePath){
  console.log('Extracting needed tables...');
  execSync(`tar --zstd -xf "${archivePath}" -C "${WORK_DIR}" db/vn db/vn_titles db/tags db/tags_vn db/tags_parents db/images db/releases db/releases_vn db/releases_titles db/releases_platforms TIMESTAMP`, { stdio: 'inherit' });

  const dumpTimestamp = readFileSync(path.join(WORK_DIR, 'TIMESTAMP'), 'utf-8').trim();
  console.log(`  dump timestamp: ${dumpTimestamp}`);
  return dumpTimestamp;
}

// image id -> the 0-2 explicit-cover score, used below to fill in each VN's `sexual` field.
function buildSexualByImageId(){
  console.log('Parsing images (for the explicit-cover flag)...');
  const imageRows = parseTSV(path.join(WORK_DIR, 'db/images'), 'images');
  // id, width, height, c_votecount, c_sexual_avg, c_sexual_stddev, c_violence_avg, c_violence_stddev, c_weight
  const sexualByImageId = new Map();
  for(const r of imageRows){
    const [id, , , , c_sexual_avg] = r;
    if(c_sexual_avg !== null) sexualByImageId.set(id, parseInt(c_sexual_avg, 10) / 100); // raw dump stores *100 versus the live API's 0-2 scale
  }
  return sexualByImageId;
}

// The base vn_id -> VN record map that every later step fills in further.
function buildVnById(sexualByImageId){
  console.log('Parsing vn table...');
  const vnRows = parseTSV(path.join(WORK_DIR, 'db/vn'), 'vn');
  const vnById = new Map();
  for(const r of vnRows){
    const [id, image, c_image, olang, votecount, c_rating, , c_length, , lengthCategory, devstatus, , description] = r;
    // c_image ("computed") is VNDB's current canonical cover, image is the original
    // reference and goes stale whenever a VN's cover is later changed, confirmed against
    // the live API: wherever the two differ, the live API always serves c_image, never
    // image. Affected ~45% of VNs (image and c_image differ), all silently showing a
    // stale cover under the local-DB path and a hard 404 under the live-API path (whose
    // image.url never matched our old image-preferring image_path). Falls back to image
    // only when c_image itself is unset.
    const resolvedImage = c_image || image;
    vnById.set(id, {
      id,
      image_path: imageIdToPath(resolvedImage),
      sexual: resolvedImage ? (sexualByImageId.get(resolvedImage) ?? null) : null,
      olang,
      votecount: parseInt(votecount, 10) || 0,
      rating: c_rating ? parseInt(c_rating, 10) / 10 : null,
      // The 1-5 category scale. VNDB's dump represents "no length set" as the literal
      // string "0" here (confirmed against the live API, which reports null for the same
      // VN), not "\N" like every other unset numeric field in this dump, "0" is still
      // truthy in JS so the ternary let it through as a real value. length IN (1,2,3,4,5)
      // then silently excluded every one of these VNs even with every length checkbox on,
      // since 0 isn't among them and SQL's IN never matches a literal 0 against that list
      // (it would if these were genuinely NULL, but they weren't).
      length: lengthCategory && lengthCategory !== '0' ? parseInt(lengthCategory, 10) : null,
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
  console.log(`  ${vnById.size} VNs parsed (all origin languages, "Originally Japanese" is a query-time filter, not applied here)`);
  return vnById;
}

// Fills in vn.title/alttitle in place, picks the official title in the VN's own original
// language, falls back to id if nothing qualifies.
function resolveVnTitles(vnById){
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
}

// tag id -> defaultspoil (VNDB's own fallback spoiler level for a tag when nobody has
// explicitly voted a spoiler rating on it for a given VN, most tags default to 0 but not
// all, e.g. "Completely Unavoidable Heroine Death" defaults to 2, it's inherently a major
// spoiler by definition even before anyone rates it as one). See buildVnTagsWithHierarchy.
function buildDefaultSpoilByTagId(){
  console.log('Parsing tags (for the defaultspoil fallback)...');
  const tagRows = parseTSV(path.join(WORK_DIR, 'db/tags'), 'tags');
  const defaultSpoilByTagId = new Map();
  for(const r of tagRows){
    const [id, , defaultspoil] = r;
    defaultSpoilByTagId.set(id.replace(/^\D+/, ''), parseInt(defaultspoil, 10) || 0);
  }
  return defaultSpoilByTagId;
}

// Aggregates thousands of individual per-user tag votes down into one (vn, tag) -> vote/
// spoiler summary. Matches VNDB's own tag_vn_calc() (code.blicky.net/yorhel/vndb,
// sql/func.sql) on two points that weren't obvious from behavior alone:
//   - Only "ignore" excludes a vote from the aggregate. "lie" doesn't: VNDB's query only
//     filters on "NOT tv.ignore", the lie flag is carried through into an aggregate boolean
//     column of its own (majority-flagged-as-lie), it never removes a voter's vote/spoiler
//     contribution. This script was excluding lie-flagged votes entirely, which could both
//     wrongly drop a tag (denominator shrinks, changing the sign-sum below) and wrongly
//     skew its spoiler level.
//   - Kept only if signSum > 0 (see buildVnTagsWithHierarchy), not average vote > 0. VNDB's
//     real inclusion test is "HAVING SUM(sign(tv.vote)) > 0", a net count of positive vs
//     negative voters, not the magnitude-weighted mean this script was using. A tag with a
//     few strongly negative votes and many mildly positive ones can have avg <= 0 while
//     still having more people vote it up than down, VNDB keeps that tag, this script was
//     dropping it. Found via a real case: a title clearly tagged "Nukige" on VNDB's live
//     site (visible, spoiler 0) had zero rows for that tag locally at all.
function aggregateTagVotes(vnById){
  console.log('Parsing and aggregating tags_vn...');
  const tagVoteRows = parseTSV(path.join(WORK_DIR, 'db/tags_vn'), 'tags_vn');
  const tagAgg = new Map();
  for(let i = 0; i < tagVoteRows.length; i++){
    const [, tag, vid, , vote, spoiler, ignore] = tagVoteRows[i];
    if(!vnById.has(vid)) continue;
    if(ignore === 't') continue;
    const key = `${vid}|${tag}`;
    if(!tagAgg.has(key)) tagAgg.set(key, { signSum: 0, voteCount: 0, spoilerSum: 0, spoilerCount: 0 });
    const agg = tagAgg.get(key);
    const v = parseFloat(vote);
    if(!isNaN(v)){ agg.signSum += Math.sign(v); agg.voteCount++; }
    if(spoiler !== null){ agg.spoilerSum += parseInt(spoiler, 10); agg.spoilerCount++; }
    if(i > 0 && i % 500000 === 0) console.log(`  aggregated ${i.toLocaleString()}/${tagVoteRows.length.toLocaleString()}`);
  }
  return tagAgg;
}

// Parses the tag hierarchy and expands the aggregated direct votes into the final
// vn_tags list, propagating each tag up to all of its ancestors. VNDB's live tag search
// also matches any ancestor of a directly-applied tag, filtering for "Fantasy" matches a
// VN only tagged with a more specific child like "Fictional Beings" too, it doesn't
// require a direct vote on "Fantasy" itself. Without this, local results systematically
// undercount the live API for any tag that has children, worse for broad parent tags.
// Every ancestor gets an implicit entry alongside the direct one, deduped against direct
// entries by keeping whichever spoiler level is least restrictive.
//
// metaTagIds excludes VNDB's category-header tags (id 1 "Theme", 20 "Character", 1107
// "Story", etc, 65 total) from that ancestor walk. These aren't real tags a VN is ever
// directly voted on, they're group headers that every real tag's ancestor chain
// eventually climbs into (nearly every "cont" tag's chain reaches "Theme" at the root),
// so without this filter almost every VN ends up with several of these headers stored
// alongside its real tags, each rendering client-side as "Unknown tag" since they're
// deliberately absent from tags.json (see syncTagNames).
function buildVnTagsWithHierarchy(tagAgg, metaTagIds, defaultSpoilByTagId){
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

  const finalByKey = new Map(); // "vid|bareTagId" -> spoiler
  for(const [key, agg] of tagAgg){
    if(agg.voteCount === 0) continue;
    if(agg.signSum <= 0) continue; // VNDB's real threshold, see the comment on aggregateTagVotes
    const [vid, tag] = key.split('|');
    // Matches VNDB's own tag_vn_calc() SQL function verbatim (code.blicky.net/yorhel/vndb,
    // sql/func.sql): CASE WHEN count(spoiler)=0 THEN min(defaultspoil) WHEN avg(spoiler)>1.3
    // THEN 2 WHEN avg(spoiler)>0.4 THEN 1 ELSE 0 END. Confirmed against a real case: a tag
    // can have votes on it (voteCount>0, it clears the signSum<=0 skip above) while nobody
    // has ever set an explicit spoiler rating on it for that VN (spoilerCount===0, spoiler
    // is optional per vote), in which case VNDB doesn't default to "not a spoiler", it falls
    // back to the tag's own defaultspoil, e.g. "Completely Unavoidable Heroine Death" is
    // defaultspoil 2, a VN can only ever be tagged with it by revealing a major spoiler, so
    // VNDB treats an unrated vote on it as spoiler level 2, not 0.
    const avgSpoiler = agg.spoilerCount ? agg.spoilerSum / agg.spoilerCount : 0;
    const spoiler = agg.spoilerCount === 0
      ? (defaultSpoilByTagId.get(tag.replace(/^\D+/, '')) ?? 0)
      : avgSpoiler > 1.3 ? 2 : avgSpoiler > 0.4 ? 1 : 0;

    for(const rawId of [tag, ...getAncestors(tag)]){
      // strips the leading "g" so this matches tags.json's bare-integer id format exactly,
      // the same mismatch already found once in render.js, fixed here at the source instead
      const bareTagId = rawId.replace(/^\D+/, '');
      if(metaTagIds.has(parseInt(bareTagId, 10))) continue;
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
  return vnTags;
}

// Fills in released_year/languages/platforms/has_en_* on vnById in place, derived from
// the releases tables (release year and English-release status are release-level facts
// in VNDB's schema, not vn-level, so they have to be rolled up here).
function deriveReleaseFlags(vnById){
  console.log('Parsing releases...');
  const releaseRows = parseTSV(path.join(WORK_DIR, 'db/releases'), 'releases');
  // id, gtin, olang, released, voiced, reso_x, reso_y, minage, ani_*, has_ero, patch, freeware, uncensored, official, catalog, notes, engine
  const releaseYearById = new Map(); // release id -> year (integer) or null
  // VNDB's own c_languages formula (the vn-level "languages" aggregate) requires
  // released <= today, excluding announced-but-unreleased titles. VNDB represents those
  // with a sentinel date far in the future (e.g. 99999999, "TBA"), which the 8-digit regex
  // below happily matches, so without this a release that's only been announced (not
  // actually out yet) could still count as "available in English", and its sentinel date
  // would also produce a garbage release year (9999).
  const todayYYYYMMDD = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
  const releaseIsReleasedById = new Map(); // release id -> boolean
  for(const r of releaseRows){
    const [id, , , released] = r;
    const releasedInt = released && /^\d{8}$/.test(released) ? parseInt(released, 10) : null;
    const isReleased = releasedInt !== null && releasedInt <= todayYYYYMMDD;
    releaseYearById.set(id, isReleased ? Math.floor(releasedInt / 10000) : null);
    releaseIsReleasedById.set(id, isReleased);
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
      // Matches VNDB's own c_languages formula for this field: non-MTL, rtype isn't
      // 'trial', and the release has actually come out (not just announced). Confirmed
      // against a real case: a VN's only English release was an unofficial patch still
      // "in-progress" per its own notes, released=TBA, whose rtype (complete) and non-MTL
      // English title otherwise looked identical to a real release, VNDB correctly leaves
      // it out of vn.languages for exactly this reason, this script wasn't checking either
      // the release date or trial status at all before.
      if(enInfo.hasEnNonMtl && rtype !== 'trial' && releaseIsReleasedById.get(relId)) vn.has_en_lang = 1;
      if(enInfo.hasMtl) vn.has_en_mtl = 1;
      // Gated on hasEnNonMtl, not hasEn: confirmed empirically against the live API that
      // VNDB's own release-level ["lang","=","en"] filter excludes MTL too, the same way
      // the vn-level "languages" field does (querying ["release","=",["and",["lang","=","en"],
      // ["rtype","=","complete"]]] for a VN whose only "complete" release's English title is
      // machine-translated, with a separate non-MTL release that's only "partial", returns
      // zero results). Gating on hasEn instead let a VN through as a false "full English
      // release" whenever completeness and non-MTL English came from two DIFFERENT releases
      // rather than the same one, e.g. a partial non-MTL patch plus an unrelated complete
      // MTL release, neither of which is actually what "Full English release" means.
      if(enInfo.hasEnNonMtl){
        vn.has_en_release_any = 1;
        if(rtype === 'complete') vn.has_en_release_complete = 1;
      }
    }
  }
  console.log('  release-derived flags computed');
}

// Replaces the vn/vn_tags tables and the dump timestamp in one transaction, so a failed
// run never leaves the live database half-loaded.
function loadDatabase(vnById, vnTags, dumpTimestamp){
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
}

async function main(){
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const metaTagIds = await syncTagNames();

  const archivePath = await resolveArchivePath();
  const dumpTimestamp = extractDumpTables(archivePath);

  const sexualByImageId = buildSexualByImageId();
  const vnById = buildVnById(sexualByImageId);
  resolveVnTitles(vnById);

  const defaultSpoilByTagId = buildDefaultSpoilByTagId();
  const tagAgg = aggregateTagVotes(vnById);
  const vnTags = buildVnTagsWithHierarchy(tagAgg, metaTagIds, defaultSpoilByTagId);

  deriveReleaseFlags(vnById);

  loadDatabase(vnById, vnTags, dumpTimestamp);

  syncCoverImages();

  console.log('Done. Cleaning up temp files...');
  rmSync(WORK_DIR, { recursive: true, force: true });
  console.log('Refresh complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
