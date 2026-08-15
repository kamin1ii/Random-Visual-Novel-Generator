import { els } from './dom.js?v=39';
import { state } from './state.js?v=39';
import { renderChips } from './tagPicker.js?v=39';

// Sidebar's own interactive behavior (slider label, toggle buttons, sub checkboxes),
// separate from filters.js which reads these same controls to build a query.

els.minRating.addEventListener('input', () => {
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

// partial patch/MTL only mean anything if "full English release" is also checked
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

// doesn't touch the active filter chips or reveal preference, main.js's Reset Filters
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
