import { state } from './state.js';
import { els } from './dom.js';
import { LENGTH_LABELS } from './constants.js';

// The one place the current filter selection is read off the DOM and out of state.js.
// buildFilters() and describeFilters() below both take this object as their only input
// instead of re-reading els/state themselves, so there is exactly one place, not three,
// that has to agree on what the current filter selection actually is.
export function gatherFilterState(){
  return {
    minVotes: parseInt(els.minVotes.value, 10) || 0,
    minRating: parseFloat(els.minRating.value) || 0,
    maxRating: parseFloat(els.maxRating.value) || 10,
    originalJapaneseOnly: els.originalJapaneseOnly.checked,
    englishOnly: els.englishOnly.checked,
    includePartialEnglish: els.includePartialEnglish.checked,
    includeMTL: els.includeMTL.checked,
    yearFrom: els.yearFrom.value ? parseInt(els.yearFrom.value, 10) : null,
    yearTo: els.yearTo.value ? parseInt(els.yearTo.value, 10) : null,
    lengths: Array.from(state.lengths).map(l => parseInt(l, 10)),
    includeTags: state.includeTags.map(t => ({ id: t.id, name: t.name })),
    excludeTags: state.excludeTags.map(t => ({ id: t.id, name: t.name })),
    includeMode: state.includeMode,
    excludeMode: state.excludeMode,
    hideSpoilerTagMatches: els.hideSpoilerTagMatches.checked,
  };
}

// Builds VNDB's nested JSON filter format for the live API path. Pure: everything it
// needs comes from filterState, produced once by gatherFilterState().
export function buildFilters(filterState){
  // VNDB represents an announced but unreleased title's date as the literal string "TBA",
  // which sorts after every real date, so "released <= today" cleanly excludes it (and
  // any real release with a future date) without needing to treat that string as a special case. Applied
  // unconditionally, not tied to any checkbox, a "generate a real thing to play" tool
  // shouldn't turn up something that isn't out yet no matter what filters are set.
  const todayStr = new Date().toISOString().slice(0, 10);
  const clauses = [["has_description","=",1], ["released","<=",todayStr]];

  if(filterState.minVotes > 0) clauses.push(["votecount",">=",filterState.minVotes]);

  if(filterState.minRating > 0) clauses.push(["rating",">=",Math.max(10, Math.round(filterState.minRating*10))]); // VNDB uses 0-100 but rejects anything below 10, UI shows 0-9.5

  if(filterState.maxRating < 10) clauses.push(["rating","<=",Math.round(filterState.maxRating*10)]);

  if(filterState.originalJapaneseOnly) clauses.push(["olang","=","ja"]);

  if(filterState.englishOnly){
    if(!filterState.includeMTL){
      // VN level "languages" already excludes MTL by definition, so this alone keeps MTL only titles out
      clauses.push(["lang","=","en"]);
    }

    // VN level check above just says an English release exists, completeness is only
    // tracked per release, hence the separate nested filter. released<=today here too,
    // same reasoning as the VN level one above but aimed at the release itself. Without
    // it, a release that's still just announced (rtype and language already set, but not
    // actually out) satisfies "complete non MTL English release" on a technicality.
    const releaseLang = ["lang","=","en"];
    const releaseReleased = ["released","<=",todayStr];
    clauses.push(["release","=", filterState.includePartialEnglish
      ? ["and", releaseLang, releaseReleased]
      : ["and", releaseLang, releaseReleased, ["rtype","=","complete"]]]);
  }

  if(filterState.yearFrom != null) clauses.push(["released",">=", filterState.yearFrom + "-01-01"]);
  if(filterState.yearTo != null) clauses.push(["released","<=", filterState.yearTo + "-12-31"]);

  // 0 keeps tag matches from firing off a tag that's flagged as a spoiler for that
  // specific title, matching purely because of one would itself leak the spoiler, since
  // the card's own tag display already hides spoiler flagged tags from view. 2 (checkbox
  // off) matches at any spoiler level, needed for tags that mostly only apply at a
  // nonzero level in the first place.
  const spoilerCap = filterState.hideSpoilerTagMatches ? 0 : 2;

  if(filterState.includeTags.length){
    const incClauses = filterState.includeTags.map(t => ["tag","=",[t.id,spoilerCap,0]]);
    if(filterState.includeMode === 'or' && incClauses.length > 1){
      clauses.push(["or", ...incClauses]);
    } else {
      clauses.push(...incClauses); // merges into the outer "and" either way
    }
  }

  if(filterState.excludeTags.length){
    const excClauses = filterState.excludeTags.map(t => ["tag","!=",[t.id,spoilerCap,0]]);
    if(filterState.excludeMode === 'and' && excClauses.length > 1){
      // "exclude only if it has every one" means keep if missing at least one, an OR of negations
      clauses.push(["or", ...excClauses]);
    } else {
      clauses.push(...excClauses);
    }
  }

  // All 5 checked means the same thing as none checked ("don't care"), matches the D1
  // path's own reasoning. A VN with no length category set never matches any of the 5
  // clauses below, so filtering on all 5 anyway would still exclude it, even though
  // checking every box reads as "show me everything" to whoever's looking at the form.
  if(filterState.lengths.length && filterState.lengths.length < 5){
    const lenClauses = filterState.lengths.map(l => ["length","=",l]);
    clauses.push(lenClauses.length > 1 ? ["or", ...lenClauses] : lenClauses[0]);
  }

  return clauses.length > 1 ? ["and", ...clauses] : clauses[0];
}

// Plain language chips above the card. Pure, same filterState as buildFilters(), so the
// two can no longer drift the way they could when each read the DOM on its own.
export function describeFilters(filterState, listSize){
  const parts = [];

  const { minRating, maxRating } = filterState;
  if(minRating > 0 && maxRating < 10) parts.push('Score ' + minRating.toFixed(1) + ' to ' + maxRating.toFixed(1));
  else if(minRating > 0) parts.push('Score ' + minRating.toFixed(1) + ' or higher');
  else if(maxRating < 10) parts.push('Score ' + maxRating.toFixed(1) + ' or lower');

  if(filterState.minVotes > 0) parts.push(filterState.minVotes + ' or more votes');

  if(filterState.originalJapaneseOnly) parts.push('Originally Japanese');
  if(filterState.englishOnly){
    let desc = filterState.includePartialEnglish ? 'English release (including partial patches)' : 'Full English release';
    if(filterState.includeMTL) desc += ', including MTL';
    parts.push(desc);
  }

  const { yearFrom, yearTo } = filterState;
  if(yearFrom != null && yearTo != null) parts.push('Released ' + yearFrom + ' to ' + yearTo);
  else if(yearFrom != null) parts.push('Released ' + yearFrom + ' or later');
  else if(yearTo != null) parts.push('Released ' + yearTo + ' or earlier');

  if(filterState.lengths.length){
    const labels = [...filterState.lengths].sort().map(l => LENGTH_LABELS[l]);
    parts.push('Length: ' + labels.join(', '));
  }

  if(filterState.includeTags.length){
    const mode = filterState.includeMode === 'or' ? 'match any' : 'match all';
    // header chip + one chip per tag, rather than one combined chip that can overflow the page
    parts.push('Includes (' + mode + '):');
    filterState.includeTags.forEach(t => parts.push(t.name));
  }

  if(filterState.excludeTags.length){
    const mode = filterState.excludeMode === 'and' ? 'only if all match' : 'if any match';
    parts.push('Excludes (' + mode + '):');
    filterState.excludeTags.forEach(t => parts.push(t.name));
  }

  parts.push(listSize + ' titles per list');

  return parts;
}
