-- Run this once to set up the database, before the first import.
-- sqlite3 /opt/rvng/data/randomvn.db < schema.sql
--
-- If you already ran the previous version of this schema, run this again too, it drops
-- and recreates the tables cleanly rather than trying to alter them in place.

DROP TABLE IF EXISTS vn;
DROP TABLE IF EXISTS vn_tags;

CREATE TABLE vn (
  id TEXT PRIMARY KEY,              -- e.g. 'v17'
  title TEXT NOT NULL,
  alttitle TEXT,
  image_path TEXT,                  -- e.g. 'cv/39/20339.jpg', matches the key format worker.js already uses for R2
  sexual REAL,                      -- 0-2 scale, same meaning as the live API's image.sexual
  olang TEXT NOT NULL,
  votecount INTEGER NOT NULL DEFAULT 0,
  rating REAL,                      -- 10-100 scale, matches the live API
  length INTEGER,                   -- 1-5 scale
  length_minutes INTEGER,
  devstatus INTEGER,
  description TEXT,
  has_description INTEGER NOT NULL DEFAULT 0,
  released_year INTEGER,            -- earliest known release year across all this VN's releases
  has_en_lang INTEGER NOT NULL DEFAULT 0,             -- has a non-MTL English release (any rtype), matches the live API's vn-level "languages" field
  has_en_release_complete INTEGER NOT NULL DEFAULT 0, -- has a "complete" rtype release with an English title
  has_en_release_any INTEGER NOT NULL DEFAULT 0,      -- has ANY rtype release with an English title, including partial/trial
  has_en_mtl INTEGER NOT NULL DEFAULT 0,               -- has at least one release specifically flagged as a machine translation
  platforms TEXT,                    -- JSON array of platform codes, e.g. ["win","mac"], display only, not filtered on
  languages TEXT,                    -- JSON array of language codes, e.g. ["ja","en"], display only, not filtered on
  rand_key REAL NOT NULL            -- precomputed random value, indexed, for efficient sampling without a full scan
);

CREATE INDEX idx_vn_rand ON vn(rand_key);
CREATE INDEX idx_vn_olang ON vn(olang);
CREATE INDEX idx_vn_votecount ON vn(votecount);
CREATE INDEX idx_vn_rating ON vn(rating);
CREATE INDEX idx_vn_has_desc ON vn(has_description);
CREATE INDEX idx_vn_released_year ON vn(released_year);
CREATE INDEX idx_vn_has_en_lang ON vn(has_en_lang);
CREATE INDEX idx_vn_has_en_complete ON vn(has_en_release_complete);
CREATE INDEX idx_vn_has_en_any ON vn(has_en_release_any);
CREATE INDEX idx_vn_has_en_mtl ON vn(has_en_mtl);
CREATE INDEX idx_vn_image_path ON vn(image_path); -- looked up on every /img/ request, must only ever cache/serve covers that belong to a VN actually in this table

-- One row per (vn, tag) pair the community consensus agrees actually applies, already
-- aggregated from thousands of individual per-user votes, spoiler-flagged tags kept in,
-- not filtered out here, that filtering happens at query time.
CREATE TABLE vn_tags (
  vn_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  spoiler INTEGER NOT NULL,         -- 0, 1, or 2, consensus spoiler level
  PRIMARY KEY (vn_id, tag_id)
);

CREATE INDEX idx_vn_tags_tag ON vn_tags(tag_id);
CREATE INDEX idx_vn_tags_vn ON vn_tags(vn_id);

-- Single-row table holding the dump's own timestamp, updated by refresh-vndb-db.mjs
-- each time it runs, so the site can show a real "last updated" date.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('dump_timestamp', NULL);
