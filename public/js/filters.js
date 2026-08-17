import { state } from './state.js?v=53';
import { els } from './dom.js?v=55';
import { LENGTH_LABELS } from './constants.js?v=53';

// Raw UI state for the D1-backed path, separate from buildFilters() below (which builds
// VNDB's specific nested JSON filter format for the live-API path). The Worker does its
// own translation into SQL server-side, so this just needs to hand over the same
// underlying values buildFilters() already reads, not VNDB's filter syntax.
export function gatherFilterState(){
  return {
    minVotes: parseInt(els.minVotes.value, 10) || 0,
    minRating: parseFloat(els.minRating.value) || 0,
    originalJapaneseOnly: els.originalJapaneseOnly.checked,
    englishOnly: els.englishOnly.checked,
    includePartialEnglish: els.includePartialEnglish.checked,
    includeMTL: els.includeMTL.checked,
    yearFrom: els.yearFrom.value ? parseInt(els.yearFrom.value, 10) : null,
    yearTo: els.yearTo.value ? parseInt(els.yearTo.value, 10) : null,
    lengths: Array.from(state.lengths).map(l => parseInt(l, 10)),
    includeTags: state.includeTags.map(t => ({ id: t.id })),
    excludeTags: state.excludeTags.map(t => ({ id: t.id })),
    includeMode: state.includeMode,
    excludeMode: state.excludeMode,
    hideSpoilerTagMatches: els.hideSpoilerTagMatches.checked,
  };
}

export function buildFilters(){
  // VNDB represents an announced-but-unreleased title's date as the literal string "TBA",
  // which sorts after every real date, so "released <= today" cleanly excludes it (and
  // any real future-dated release) without needing to special-case that string. Applied
  // unconditionally, not tied to any checkbox, a "generate a real thing to play" tool
  // shouldn't turn up something that isn't out yet no matter what filters are set.
  const todayStr = new Date().toISOString().slice(0, 10);
  const clauses = [["has_description","=",1], ["released","<=",todayStr]];

  const minVotes = parseInt(els.minVotes.value, 10) || 0;
  if(minVotes > 0) clauses.push(["votecount",">=",minVotes]);

  const minRating = parseFloat(els.minRating.value);
  if(minRating > 0) clauses.push(["rating",">=",Math.max(10, Math.round(minRating*10))]); // VNDB uses 0-100 but rejects anything below 10, UI shows 0-9.5

  if(els.originalJapaneseOnly.checked) clauses.push(["olang","=","ja"]);

  if(els.englishOnly.checked){
    const includePartial = els.includePartialEnglish.checked;
    const includeMTL = els.includeMTL.checked;

    if(!includeMTL){
      // vn-level "languages" already excludes MTL by definition, so this alone keeps MTL-only titles out
      clauses.push(["lang","=","en"]);
    }

    // vn-level check above just says an English release exists, completeness is only
    // tracked per-release, hence the separate nested filter. released<=today here too,
    // same reasoning as the vn-level one above but aimed at the release itself: without
    // it, a release that's still just announced (rtype and language already set, but not
    // actually out) satisfies "complete non-MTL English release" on a technicality.
    const releaseLang = ["lang","=","en"];
    const releaseReleased = ["released","<=",todayStr];
    clauses.push(["release","=", includePartial
      ? ["and", releaseLang, releaseReleased]
      : ["and", releaseLang, releaseReleased, ["rtype","=","complete"]]]);
  }

  const yearFrom = parseInt(els.yearFrom.value, 10);
  const yearTo = parseInt(els.yearTo.value, 10);
  if(!isNaN(yearFrom)) clauses.push(["released",">=", yearFrom + "-01-01"]);
  if(!isNaN(yearTo)) clauses.push(["released","<=", yearTo + "-12-31"]);

  // 0 keeps tag matches from firing off a tag that's flagged as a spoiler for that
  // specific title, matching purely because of one would itself leak the spoiler, since
  // the card's own tag display already hides spoiler-flagged tags from view. 2 (checkbox
  // off) matches at any spoiler level, needed for tags that mostly only apply at a
  // nonzero level in the first place.
  const spoilerCap = els.hideSpoilerTagMatches.checked ? 0 : 2;

  if(state.includeTags.length){
    const incClauses = state.includeTags.map(t => ["tag","=",[t.id,spoilerCap,0]]);
    if(state.includeMode === 'or' && incClauses.length > 1){
      clauses.push(["or", ...incClauses]);
    } else {
      clauses.push(...incClauses); // merges into the outer "and" either way
    }
  }

  if(state.excludeTags.length){
    const excClauses = state.excludeTags.map(t => ["tag","!=",[t.id,spoilerCap,0]]);
    if(state.excludeMode === 'and' && excClauses.length > 1){
      // "exclude only if it has every one" means keep if missing at least one, an OR of negations
      clauses.push(["or", ...excClauses]);
    } else {
      clauses.push(...excClauses);
    }
  }

  // All 5 checked means the same thing as none checked ("don't care"), matches the D1
  // path's own reasoning: a VN with no length category set never matches any of the 5
  // clauses below, so filtering on all 5 anyway would still exclude it, even though
  // checking every box reads as "show me everything" to whoever's looking at the form.
  if(state.lengths.size && state.lengths.size < 5){
    const lenClauses = Array.from(state.lengths).map(l => ["length","=",parseInt(l,10)]);
    clauses.push(lenClauses.length > 1 ? ["or", ...lenClauses] : lenClauses[0]);
  }

  return clauses.length > 1 ? ["and", ...clauses] : clauses[0];
}

// mirrors buildFilters but for the plain-language chips above the card, kept in sync by hand
export function describeFilters(){
  const parts = [];

  const minRating = parseFloat(els.minRating.value);
  if(minRating > 0) parts.push('Score ' + minRating.toFixed(1) + ' or higher');

  const minVotes = parseInt(els.minVotes.value, 10) || 0;
  if(minVotes > 0) parts.push(minVotes + ' or more votes');

  if(els.originalJapaneseOnly.checked) parts.push('Originally Japanese');
  if(els.englishOnly.checked){
    let desc = els.includePartialEnglish.checked ? 'English release (including partial patches)' : 'Full English release';
    if(els.includeMTL.checked) desc += ', including MTL';
    parts.push(desc);
  }

  const yearFrom = parseInt(els.yearFrom.value, 10);
  const yearTo = parseInt(els.yearTo.value, 10);
  if(!isNaN(yearFrom) && !isNaN(yearTo)) parts.push('Released ' + yearFrom + ' to ' + yearTo);
  else if(!isNaN(yearFrom)) parts.push('Released ' + yearFrom + ' or later');
  else if(!isNaN(yearTo)) parts.push('Released ' + yearTo + ' or earlier');

  if(state.lengths.size){
    const labels = Array.from(state.lengths).sort().map(l => LENGTH_LABELS[l]);
    parts.push('Length: ' + labels.join(', '));
  }

  if(state.includeTags.length){
    const mode = state.includeMode === 'or' ? 'match any' : 'match all';
    // header chip + one chip per tag, rather than one combined chip that can overflow the page
    parts.push('Includes (' + mode + '):');
    state.includeTags.forEach(t => parts.push(t.name));
  }

  if(state.excludeTags.length){
    const mode = state.excludeMode === 'and' ? 'only if all match' : 'if any match';
    parts.push('Excludes (' + mode + '):');
    state.excludeTags.forEach(t => parts.push(t.name));
  }

  parts.push(els.listSize.value + ' titles per list');

  return parts;
}
