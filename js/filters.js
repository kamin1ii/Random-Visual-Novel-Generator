import { state } from './state.js?v=50';
import { els } from './dom.js?v=50';
import { LENGTH_LABELS } from './constants.js?v=50';

export function buildFilters(){
  const clauses = [["has_description","=",1]];

  const minVotes = parseInt(els.minVotes.value, 10) || 0;
  if(minVotes > 0) clauses.push(["votecount",">=",minVotes]);

  const minRating = parseFloat(els.minRating.value);
  if(minRating > 0) clauses.push(["rating",">=",Math.round(minRating*10)]); // VNDB uses 0-100, UI shows 0-10

  if(els.originalJapaneseOnly.checked) clauses.push(["olang","=","ja"]);

  if(els.englishOnly.checked){
    const includePartial = els.includePartialEnglish.checked;
    const includeMTL = els.includeMTL.checked;

    if(!includeMTL){
      // VN level "languages" already excludes MTL by definition, so this alone keeps MTL only titles out
      clauses.push(["lang","=","en"]);
    }

    // VN level check above just says an English release exists, completeness is only
    // tracked per-release, hence the separate nested filter
    const releaseLang = ["lang","=","en"];
    clauses.push(["release","=", includePartial ? releaseLang : ["and", releaseLang, ["rtype","=","complete"]]]);
  }

  const yearFrom = parseInt(els.yearFrom.value, 10);
  const yearTo = parseInt(els.yearTo.value, 10);
  if(!isNaN(yearFrom)) clauses.push(["released",">=", yearFrom + "-01-01"]);
  if(!isNaN(yearTo)) clauses.push(["released","<=", yearTo + "-12-31"]);

  if(state.includeTags.length){
    // spoiler cap of 2, not the default 0, since many story/genre tags only apply at a nonzero level
    const incClauses = state.includeTags.map(t => ["tag","=",[t.id,2,0]]);
    if(state.includeMode === 'or' && incClauses.length > 1){
      clauses.push(["or", ...incClauses]);
    } else {
      clauses.push(...incClauses); // merges into the outer "and" either way
    }
  }

  if(state.excludeTags.length){
    const excClauses = state.excludeTags.map(t => ["tag","!=",[t.id,2,0]]);
    if(state.excludeMode === 'and' && excClauses.length > 1){
      // "exclude only if it has every one" means keep if missing at least one, an OR of negations
      clauses.push(["or", ...excClauses]);
    } else {
      clauses.push(...excClauses);
    }
  }

  if(state.lengths.size){
    const lenClauses = Array.from(state.lengths).map(l => ["length","=",parseInt(l,10)]);
    clauses.push(lenClauses.length > 1 ? ["or", ...lenClauses] : lenClauses[0]);
  }

  return clauses.length > 1 ? ["and", ...clauses] : clauses[0];
}

// mirrors buildFilters but for the plain language chips above the card, kept in sync by hand
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
