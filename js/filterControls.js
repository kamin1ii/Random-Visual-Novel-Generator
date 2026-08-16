import { els } from './dom.js?v=52';
import { state } from './state.js?v=52';
import { renderChips } from './tagPicker.js?v=52';

// Sidebar's own interactive behavior (slider label, toggle buttons, sub-checkboxes),
// separate from filters.js which reads these same controls to build a query.

els.minRating.addEventListener('input', () => {
  if(parseFloat(els.minRating.value) === 0.5){
    els.minRating.value = 1; // VNDB's rating filter has no meaningful distinction below 1, don't offer a step that looks like an option but isn't one
  }
  const v = parseFloat(els.minRating.value);
  els.minRatingVal.textContent = v === 0 ? 'Any' : v.toFixed(1);
});

els.lengthGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.len-toggle');
  if(!btn) return;
  const len = btn.dataset.len;
  if(state.lengths.has(len)){
    state.lengths.delete(len);
    btn.classList.remove('active');
  } else {
    state.lengths.add(len);
    btn.classList.add('active');
  }
});

els.includeModeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.len-toggle');
  if(!btn) return;
  state.includeMode = btn.dataset.mode;
  btn.parentElement.querySelectorAll('.len-toggle').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

els.excludeModeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.len-toggle');
  if(!btn) return;
  state.excludeMode = btn.dataset.mode;
  btn.parentElement.querySelectorAll('.len-toggle').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

// partial-patch/MTL only mean anything if "full English release" is also checked
function syncEnglishSubOptions(){
  const enabled = els.englishOnly.checked;
  els.includePartialEnglish.disabled = !enabled;
  els.includeMTL.disabled = !enabled;
  if(!enabled){
    els.includePartialEnglish.checked = false;
    els.includeMTL.checked = false;
  }
}
els.englishOnly.addEventListener('change', syncEnglishSubOptions);
syncEnglishSubOptions();

// doesn't touch the active-filters chips or reveal preference, main.js's Reset Filters
// handler calls this alongside those separately
export function resetFilterUI(){
  els.minRating.value = 0;
  els.minRatingVal.textContent = 'Any';
  els.minVotes.value = 10;
  els.englishOnly.checked = true;
  els.includePartialEnglish.checked = false;
  els.includeMTL.checked = false;
  syncEnglishSubOptions();
  els.originalJapaneseOnly.checked = true;
  els.yearFrom.value = '';
  els.yearTo.value = '';
  state.lengths.clear();
  els.lengthGrid.querySelectorAll('.len-toggle').forEach(b => b.classList.remove('active'));

  // Nukige's exclusion is preserved across a reset instead of forced back to the
  // default, so removing it (or deliberately keeping it) isn't silently undone every
  // time the rest of the filters get reset.
  const hadNukigeExcluded = state.excludeTags.some(t => t.id === 214);
  // Cleared in place (length = 0), not reassigned (= []). tagPicker.js's closures
  // captured these exact array references at setup time, replacing them with brand new
  // arrays here would silently detach those closures from state, chips would still
  // render correctly (same closure-held array) but buildFilters() would read the new,
  // permanently-empty reference and never see anything added after a reset.
  state.includeTags.length = 0;
  state.excludeTags.length = 0;
  if(hadNukigeExcluded) state.excludeTags.push({ id: 214, name: 'Nukige' });
  renderChips(state.includeTags, els.includeChips, 'include');
  renderChips(state.excludeTags, els.excludeChips, 'exclude');

  els.listSize.value = '50';
  state.includeMode = 'and';
  state.excludeMode = 'or';
  // matched by data-mode value rather than a hardcoded index, since the two toggles
  // don't have the same button order, and-first for include, or-first for exclude,
  // the earlier index-based version activated whichever button was first regardless
  // of which mode that actually was, breaking the exclude toggle's visual state
  els.includeModeToggle.querySelectorAll('.len-toggle').forEach(b => b.classList.toggle('active', b.dataset.mode === 'and'));
  els.excludeModeToggle.querySelectorAll('.len-toggle').forEach(b => b.classList.toggle('active', b.dataset.mode === 'or'));
}
