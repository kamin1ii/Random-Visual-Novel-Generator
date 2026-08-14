import { els } from './dom.js?v=20';
import { state } from './state.js?v=20';
import { runQuery } from './api.js?v=20';
import { buildFilters, describeFilters } from './filters.js?v=20';
import { resetFilterUI } from './filterControls.js?v=20';
import { makeTagPicker } from './tagPicker.js?v=20';
import { showCurrent, setStatus, renderActiveFilters } from './render.js?v=20';
import { initRevealModal, closeRevealModal, isRevealModalOpen, resetRevealPreference } from './revealModal.js?v=20';

makeTagPicker(els.includeInput, els.includeSuggest, els.includeStatus, state.includeTags, els.includeChips, 'include');
makeTagPicker(els.excludeInput, els.excludeSuggest, els.excludeStatus, state.excludeTags, els.excludeChips, 'exclude');

// A small enough popup (toggle a class on OK/backdrop click/Escape) that it doesn't
// warrant its own file the way revealModal.js does, that one manages a persisted
// preference synced across two separate controls, this is just an alert-style dialog.
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
  els.generateBtn.disabled = true; // prevents overlapping requests if clicked again mid-fetch
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

// Runs on page load so there's something on screen before the person has touched any filter.
async function loadInitialPick(){
  try{
    const filters = ["and", ["has_description","=",1], ["votecount",">=",10], ["olang","=","ja"]];
    const { results } = await runQuery(filters, 1);
    if(results.length){
      state.list = results;
      state.index = 0;
      state.isPlaceholder = true; // distinguishes this from a real generated list, disables nav/click-to-advance
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
  // While either modal is open, arrow keys shouldn't advance the card behind it, and
  // Escape should close whichever one is actually open rather than doing nothing.
  if(isNoResultsModalOpen()){
    if(e.key === 'Escape') closeNoResultsModal();
    return;
  }
  if(isRevealModalOpen()){
    if(e.key === 'Escape') closeRevealModal();
    return;
  }
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

initRevealModal();

els.nextBtn.addEventListener('click', goNext);
els.prevBtn.addEventListener('click', goPrev);
els.generateBtn.addEventListener('click', generateList);

els.resetBtn.addEventListener('click', () => {
  resetFilterUI();
  els.activeFilters.innerHTML = '';
  resetRevealPreference(); // back to asking before each explicit reveal
  setStatus('Filters reset. Generate a list to begin.');
});

loadInitialPick();
