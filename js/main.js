import { els } from './dom.js?v=34';
import { state } from './state.js?v=34';
import { runQuery } from './api.js?v=34';
import { buildFilters, describeFilters } from './filters.js?v=34';
import { resetFilterUI } from './filterControls.js?v=34';
import { makeTagPicker } from './tagPicker.js?v=34';
import { showCurrent, setStatus, renderActiveFilters } from './render.js?v=34';
import { initRevealModal, closeRevealModal, isRevealModalOpen, resetRevealPreference } from './revealModal.js?v=34';
import { SENSITIVE_THRESHOLD } from './constants.js?v=34';

makeTagPicker(els.includeInput, els.includeSuggest, els.includeStatus, state.includeTags, els.includeChips, 'include');
makeTagPicker(els.excludeInput, els.excludeSuggest, els.excludeStatus, state.excludeTags, els.excludeChips, 'exclude');

// too small to need its own file like revealModal.js, that one manages a persisted
// preference across two controls, this is just an alert dialog
function showNoResultsModal(message){
  els.noResultsBody.textContent = message;
  els.noResultsModal.classList.add('open');
}
function closeNoResultsModal(){
  els.noResultsModal.classList.remove('open');
}
function isNoResultsModalOpen(){
  return els.noResultsModal.classList.contains('open');
}
els.noResultsOk.addEventListener('click', closeNoResultsModal);
els.noResultsModal.addEventListener('click', (e) => {
  if(e.target === els.noResultsModal) closeNoResultsModal();
});

async function generateList(){
  els.generateBtn.disabled = true;
  setStatus('Searching VNDB…');
  try{
    const filters = buildFilters();
    const listSize = parseInt(els.listSize.value, 10);
    const { count, results } = await runQuery(filters, listSize);
    if(!count){
      setStatus('No titles match those filters. Try loosening them.');
      showNoResultsModal('No titles match those filters. Try loosening them.');
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

// runs on page load, before anyone's touched a filter. Fetches a small batch instead of
// one result so an explicit cover can be filtered out, nobody asked for this pick, so it
// shouldn't be the one place the reveal-confirmation flow gets skipped.
async function loadInitialPick(){
  try{
    const filters = ["and", ["has_description","=",1], ["votecount",">=",10], ["olang","=","ja"]];
    const { results } = await runQuery(filters, 20);
    const nonExplicit = results.filter(vn => !(vn.image && vn.image.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD));
    const pool = nonExplicit.length ? nonExplicit : results; // fallback for the rare case every pick got flagged
    if(pool.length){
      state.list = [pool[0]]; // already shuffled by runQuery
      state.index = 0;
      state.isPlaceholder = true;
      setStatus('A random pick to start. Set filters on the left and generate your own list.');
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
  state.index = (state.index + 1) % state.list.length;
  showCurrent();
}

function goPrev(){
  if(!state.list.length) return;
  state.index = (state.index - 1 + state.list.length) % state.list.length;
  showCurrent();
}

els.card.addEventListener('click', (e) => {
  if(e.target.closest('#coverLink') || e.target.closest('#vndbLink') || e.target.closest('#revealBtn') || e.target.closest('.tag-more')) return;
  if(state.isPlaceholder) return;
  goNext();
});

// on document, not the card, so arrow keys work without clicking the card first
document.addEventListener('keydown', (e) => {
  if(isNoResultsModalOpen()){
    if(e.key === 'Escape') closeNoResultsModal();
    return;
  }
  if(isRevealModalOpen()){
    if(e.key === 'Escape') closeRevealModal();
    return;
  }
  if(state.isPlaceholder) return;
  const tag = document.activeElement.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // don't hijack typing elsewhere
  if(e.key === 'ArrowRight'){ e.preventDefault(); goNext(); }
  if(e.key === 'ArrowLeft'){ e.preventDefault(); goPrev(); }
});

els.coverLink.addEventListener('click', (e) => { e.stopPropagation(); });
els.vndbLink.addEventListener('click', (e) => { e.stopPropagation(); });

initRevealModal();

els.nextBtn.addEventListener('click', goNext);
els.prevBtn.addEventListener('click', goPrev);
els.generateBtn.addEventListener('click', generateList);

els.resetBtn.addEventListener('click', () => {
  resetFilterUI();
  els.activeFilters.innerHTML = '';
  resetRevealPreference();
  setStatus('Filters reset. Generate a list to begin.');
});

loadInitialPick();
