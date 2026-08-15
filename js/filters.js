import { state } from './state.js?v=33';
import { els } from './dom.js?v=33';
import { LENGTH_LABELS } from './constants.js?v=33';

export function buildFilters(){
  const clauses = [["has_description","=",1]]; // otherwise the card could show a title with nothing to say about it

  const minVotes = parseInt(els.minVotes.value, 10) || 0; // guards against NaN when the box is empty
  if(minVotes > 0) clauses.push(["votecount",">=",minVotes]);

  const minRating = parseFloat(els.minRating.value);
  if(minRating > 0) clauses.push(["rating",">=",Math.round(minRating*10)]); // VNDB uses 0-100, the UI shows 0-10

  if(els.originalJapaneseOnly.checked) clauses.push(["olang","=","ja"]);

  if(els.englishOnly.checked){
    const includePartial = els.includePartialEnglish.checked;
    const includeMTL = els.includeMTL.checked;

    if(!includeMTL){
      // VNDB's aggregate vn-level "languages" field excludes machine translations by
      // definition, so this alone is what keeps MTL-only titles out by default.
      clauses.push(["lang","=","en"]);
    }

    // The vn-level check above says an English release exists somewhere, it says nothing
    // about completeness, that's only tracked per-release, hence the separate nested filter.
    const releaseLang = ["lang","=","en"];
    clauses.push(["release","=", includePartial ? releaseLang : ["and", releaseLang, ["rtype","=","complete"]]]);
  }

  const yearFrom = parseInt(els.yearFrom.value, 10);
  const yearTo = parseInt(els.yearTo.value, 10);
  if(!isNaN(yearFrom)) clauses.push(["released",">=", yearFrom + "-01-01"]);
  if(!isNaN(yearTo)) clauses.push(["released","<=", yearTo + "-12-31"]);

  if(state.includeTags.length){
    // Spoiler cap of 2 (not the default 0) because many story/genre tags are only
    // applied at a nonzero spoiler level, filtering at 0 was silently excluding them.
    const incClauses = state.includeTags.map(t => ["tag","=",[t.id,2,0]]);
    if(state.includeMode === 'or' && incClauses.length > 1){
      clauses.push(["or", ...incClauses]);
    } else {
      // left as separate clauses rather than wrapped in "and", they merge into the
      // outer "and" built at the end of this function either way
      clauses.push(...incClauses);
    }
  }

  if(state.excludeTags.length){
    const excClauses = state.excludeTags.map(t => ["tag","!=",[t.id,2,0]]);
    if(state.excludeMode === 'and' && excClauses.length > 1){
      // "exclude only if it has every one of these" means keep it if it's missing at
      // least one, which is an OR of the negations, not an AND
      clauses.push(["or", ...excClauses]);
    } else {
      clauses.push(...excClauses);
    }
  }

  if(state.lengths.size){
    const lenClauses = Array.from(state.lengths).map(l => ["length","=",parseInt(l,10)]);
    clauses.push(lenClauses.length > 1 ? ["or", ...lenClauses] : lenClauses[0]);
  }

  // avoids wrapping a single clause in a redundant ["and", ...]
  return clauses.length > 1 ? ["and", ...clauses] : clauses[0];
}

// Mirrors buildFilters, but produces the plain-language chips shown above the card
// instead of VNDB's filter syntax, so the two need to be kept in sync by hand.
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
    // A short header chip, then one chip per tag, rather than joining every tag name
    // into a single chip: with enough tags that one combined chip becomes wider than
    // the page and (being nowrap) spills off the edge instead of wrapping.
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
