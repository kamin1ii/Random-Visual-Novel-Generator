// Pure filter to SQL translation, no database or network dependency, kept separate from
// generate.js so it can be unit tested without needing a live database connection.

// Every WHERE clause is built with real parameterized placeholders (bind, not string
// interpolation), this endpoint handles live public input, unlike the offline import
// script, so this matters here in a way it didn't there.
export function buildWhereClause(filters){
  // Baseline, always applied regardless of UI settings. released_year is only ever set
  // (db/refresh-vndb-db.mjs, deriveReleaseFlags) from a release that's actually out, not
  // an announced/TBA one, so NULL here means literally nothing about this VN has released
  // yet, an announce only or still in development title shouldn't turn up in a "generate
  // a real thing to play" tool no matter what filters are set.
  const conditions = ['has_description = 1', 'released_year IS NOT NULL'];
  const params = [];

  const minVotes = parseInt(filters.minVotes, 10) || 0;
  if(minVotes > 0){
    conditions.push('votecount >= ?');
    params.push(minVotes);
  }

  const minRating = parseFloat(filters.minRating) || 0;
  if(minRating > 0){
    // clamped to 10, same fix as the live API version, values below 10 aren't meaningfully distinct
    conditions.push('rating >= ?');
    params.push(Math.max(10, Math.round(minRating * 10)));
  }

  const maxRating = parseFloat(filters.maxRating) || 10;
  if(maxRating < 10){
    conditions.push('rating <= ?');
    params.push(Math.round(maxRating * 10));
  }

  if(filters.originalJapaneseOnly){
    conditions.push("olang = 'ja'");
  }

  if(filters.englishOnly){
    if(!filters.includeMTL){
      conditions.push('has_en_lang = 1'); // VN level non MTL English existence, matches the live API's "languages" semantics
    }
    conditions.push(filters.includePartialEnglish ? 'has_en_release_any = 1' : 'has_en_release_complete = 1');
  }

  const yearFrom = parseInt(filters.yearFrom, 10);
  if(!isNaN(yearFrom)){
    conditions.push('released_year >= ?');
    params.push(yearFrom);
  }
  const yearTo = parseInt(filters.yearTo, 10);
  if(!isNaN(yearTo)){
    conditions.push('released_year <= ?');
    params.push(yearTo);
  }

  if(Array.isArray(filters.lengths) && filters.lengths.length){
    const validLengths = filters.lengths.map(l => parseInt(l, 10)).filter(l => l >= 1 && l <= 5);
    // All 5 checked means the same thing as none checked ("don't care"), everywhere else
    // in this UI an empty selection means no restriction, this should behave the same way
    // rather than emitting length IN (1,2,3,4,5), which (unlike skipping the condition
    // entirely) actively excludes any VN whose length category isn't set at all, NULL
    // never satisfies IN(), so those titles silently vanished even with every box checked.
    if(validLengths.length && validLengths.length < 5){
      conditions.push(`length IN (${validLengths.map(() => '?').join(',')})`);
      params.push(...validLengths);
    }
  }

  // 0 keeps tag matches from firing off a tag that's only a spoiler for that specific
  // title, 2 (checkbox off) matches at any spoiler level, same meaning as the live API version.
  const spoilerCap = filters.hideSpoilerTagMatches === false ? 2 : 0;

  if(Array.isArray(filters.includeTags) && filters.includeTags.length){
    const tagConds = filters.includeTags.map(t => {
      params.push(String(t.id), spoilerCap);
      return 'EXISTS (SELECT 1 FROM vn_tags WHERE vn_tags.vn_id = vn.id AND vn_tags.tag_id = ? AND vn_tags.spoiler <= ?)';
    });
    conditions.push(filters.includeMode === 'or' && tagConds.length > 1
      ? `(${tagConds.join(' OR ')})`
      : tagConds.join(' AND '));
  }

  if(Array.isArray(filters.excludeTags) && filters.excludeTags.length){
    const tagConds = filters.excludeTags.map(t => {
      params.push(String(t.id), spoilerCap);
      return 'NOT EXISTS (SELECT 1 FROM vn_tags WHERE vn_tags.vn_id = vn.id AND vn_tags.tag_id = ? AND vn_tags.spoiler <= ?)';
    });
    // "exclude only if it has every one" means keep if missing at least one, an OR
    conditions.push(filters.excludeMode === 'and' && tagConds.length > 1
      ? `(${tagConds.join(' OR ')})`
      : tagConds.join(' AND '));
  }

  return { where: conditions.join(' AND '), params };
}
