import { els } from './dom.js?v=27';
import { state } from './state.js?v=27';
import { renderChips } from './tagPicker.js?v=27';

// Wires the sidebar's own interactive behavior: live slider label, length/mode toggle
// buttons, and the English-release sub-checkboxes. This is distinct from filters.js,
// which reads the CURRENT state of these same controls to build a VNDB query, this file
// is only concerned with how the controls themselves behave when clicked or changed.

els.minRating.addEventListener('input', () => {
  const v = parseFloat(els.minRating.value);
  els.minRatingVal.textContent = v === 0 ? 'Any' : v.toFixed(1); // 0 reads as "no minimum", not "0.0"
});

// Delegated to the container instead of one listener per button, so adding or removing
// a length option later doesn't require re-wiring individual event listeners.
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

// The partial-patch and MTL checkboxes only mean anything if "full English release" is
// also checked, disabling them prevents a misleading "on but irrelevant" state, and
// force-unchecking them when the parent turns off stops them silently staying "on" while hidden.
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

// Resets every sidebar filter control back to its default value. Deliberately doesn't
// touch the active-filters recap chips or the reveal preference, those belong to other
// subsystems (render.js's chips, revealModal.js's own reset), main.js's Reset Filters
// handler calls this alongside those, rather than this function reaching into either.
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
  state.includeTags = [];
  state.excludeTags = [];
  renderChips(state.includeTags, els.includeChips, 'include');
  renderChips(state.excludeTags, els.excludeChips, 'exclude');
  els.listSize.value = '50';
  state.includeMode = 'and';
  state.excludeMode = 'or';
  els.includeModeToggle.querySelectorAll('.len-toggle').forEach((b,i) => b.classList.toggle('active', i===0));
  els.excludeModeToggle.querySelectorAll('.len-toggle').forEach((b,i) => b.classList.toggle('active', i===0));
}
