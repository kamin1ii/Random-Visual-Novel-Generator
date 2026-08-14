import { els } from './dom.js?v=9';
import { state } from './state.js?v=9';
import { runQuery } from './api.js?v=9';
import { buildFilters, describeFilters } from './filters.js?v=9';
import { makeTagPicker, renderChips } from './tagPicker.js?v=9';
import { showCurrent, setStatus, renderActiveFilters } from './render.js?v=9';

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

makeTagPicker(els.includeInput, els.includeSuggest, els.includeStatus, state.includeTags, els.includeChips, 'include');
makeTagPicker(els.excludeInput, els.excludeSuggest, els.excludeStatus, state.excludeTags, els.excludeChips, 'exclude');

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

async function generateList(){
  els.generateBtn.disabled = true; // prevents overlapping requests if clicked again mid-fetch
  setStatus('Searching VNDB…');
  try{
    const filters = buildFilters();
    const listSize = parseInt(els.listSize.value, 10);
    const { count, results } = await runQuery(filters, listSize);
    if(!count){
      setStatus('No titles match those filters. Try loosening them.');
      return;
    }
    if(!results.length){
      setStatus('No titles in this batch. Try generating again.');
      return;
    }
    state.list = results;
    state.index = 0;
    state.isPlaceholder = false;
    setStatus(count.toLocaleString() + ' titles match. Showing ' + results.length + ' of them.');
    renderActiveFilters(describeFilters());
    els.prevBtn.disabled = false;
    els.nextBtn.disabled = false;
    showCurrent();
  }catch(err){
    setStatus(err.message || 'Something went wrong reaching VNDB.');
  }finally{
    els.generateBtn.disabled = false;
  }
}

// Runs on page load so there's something on screen before the person has touched any filter.
async function loadInitialPick(){
  try{
    const filters = ["and", ["has_description","=",1], ["votecount",">=",10], ["olang","=","ja"]];
    const { results } = await runQuery(filters, 1);
    if(results.length){
      state.list = results;
      state.index = 0;
      state.isPlaceholder = true; // distinguishes this from a real generated list, disables nav/click-to-advance
      setStatus('A random pick to start you off. Set filters on the left and generate your own list anytime.');
      showCurrent();
    } else {
      setStatus('Set your filters and generate a list to begin.');
    }
  }catch(err){
    setStatus('Set your filters and generate a list to begin.');
  }
}

function goNext(){
  if(!state.list.length) return;
  state.index = (state.index + 1) % state.list.length; // wraps back to the start past the last entry
  showCurrent();
}

function goPrev(){
  if(!state.list.length) return;
  state.index = (state.index - 1 + state.list.length) % state.list.length; // avoids a negative index at the start
  showCurrent();
}

// closest() check here is a backup, coverLink/vndbLink/revealBtn each already stop
// propagation themselves, this just guards against that ever being removed by accident.
els.card.addEventListener('click', (e) => {
  if(e.target.closest('#coverLink') || e.target.closest('#vndbLink') || e.target.closest('#revealBtn') || e.target.closest('.tag-more')) return;
  if(state.isPlaceholder) return;
  goNext();
});

// Listens on "document" rather than the card itself, so arrow keys work without first
// clicking the card to focus it.
document.addEventListener('keydown', (e) => {
  if(state.isPlaceholder) return;
  // skips VN navigation while typing anywhere, so this doesn't fight with the tag
  // search's own arrow key handling or move the cursor in a number field
  const tag = document.activeElement.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if(e.key === 'ArrowRight'){ e.preventDefault(); goNext(); }
  if(e.key === 'ArrowLeft'){ e.preventDefault(); goPrev(); }
});

// Without stopPropagation, clicking the cover would also trigger the card's click
// handler and advance to the next entry at the same moment the link opened.
els.coverLink.addEventListener('click', (e) => { e.stopPropagation(); });
els.vndbLink.addEventListener('click', (e) => { e.stopPropagation(); });

els.revealBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // otherwise this click would also advance to the next entry
  els.cover.classList.remove('sensitive');
  els.revealBtn.classList.remove('show');
});

els.nextBtn.addEventListener('click', goNext);
els.prevBtn.addEventListener('click', goPrev);
els.generateBtn.addEventListener('click', generateList);

els.resetBtn.addEventListener('click', () => {
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
  els.activeFilters.innerHTML = '';
  setStatus('Filters reset. Generate a list to begin.');
});

loadInitialPick();
