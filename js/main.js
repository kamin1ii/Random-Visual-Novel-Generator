import { els } from './dom.js?v=49';
import { state } from './state.js?v=49';
import { runQuery, fetchRandomPool } from './api.js?v=49';
import { buildFilters, describeFilters } from './filters.js?v=49';
import { resetFilterUI } from './filterControls.js?v=49';
import { makeTagPicker, renderChips } from './tagPicker.js?v=49';
import { showCurrent, setStatus, renderActiveFilters } from './render.js?v=49';
import { initRevealModal, closeRevealModal, isRevealModalOpen, resetRevealPreference } from './revealModal.js?v=49';

makeTagPicker(els.includeInput, els.includeSuggest, els.includeStatus, state.includeTags, els.includeChips, 'include');
makeTagPicker(els.excludeInput, els.excludeSuggest, els.excludeStatus, state.excludeTags, els.excludeChips, 'exclude');
// renders the default Nukige chip on load, chip rendering otherwise only happens on
// add/remove/reset, without this the exclude filter would be silently active with no
// visible chip until the person reset filters once
renderChips(state.includeTags, els.includeChips, 'include');
renderChips(state.excludeTags, els.excludeChips, 'exclude');

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

function showRateLimitModal(){
  els.rateLimitModal.classList.add('open');
}
function closeRateLimitModal(){
  els.rateLimitModal.classList.remove('open');
}
function isRateLimitModalOpen(){
  return els.rateLimitModal.classList.contains('open');
}
els.rateLimitOk.addEventListener('click', closeRateLimitModal);
els.rateLimitModal.addEventListener('click', (e) => {
  if(e.target === els.rateLimitModal) closeRateLimitModal();
});

let rateLimitedUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 90000; // matches the "a minute or two" wording in the modal

function startRateLimitCooldown(){
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  showRateLimitModal();
}

async function generateList(){
  if(Date.now() < rateLimitedUntil){
    showRateLimitModal(); // still cooling down, re-show without calling VNDB again
    return;
  }
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
    if(err.status === 429){
      startRateLimitCooldown();
      setStatus('VNDB rate limit reached. Wait a minute or two before trying again.');
    } else {
      setStatus(err.message || 'Something went wrong reaching VNDB.');
    }
  }finally{
    els.generateBtn.disabled = false;
  }
}

// runs on page load, before anyone's touched a filter
async function loadInitialPick(){
  try{
    // tag 214 = Nukige, excluded server-side so this doesn't need a pool to filter
    // locally, one candidate is enough since VNDB already guarantees it isn't nukige
    const filters = ["and", ["has_description","=",1], ["votecount",">=",10], ["olang","=","ja"], ["tag","!=",[214,2,0]]];
    const { results } = await fetchRandomPool(filters, 1);
    if(results.length){
      state.list = [results[0]];
      state.index = 0;
      state.isPlaceholder = true;
      setStatus('A random pick to start. Filters are on the left, use them to generate a list.');
      showCurrent();
    } else {
      setStatus('Set your filters and generate a list to begin.');
    }
  }catch(err){
    if(err.status === 429){
      startRateLimitCooldown();
      setStatus('VNDB rate limit reached. Wait a minute or two, then generate a list.');
      els.titleMain.textContent = 'Rate limited';
      els.titleAlt.textContent = '';
      els.synopsis.textContent = 'VNDB\u2019s rate limit was reached while loading a starting pick. This isn\u2019t a missing cover, nothing was fetched yet, wait a minute or two and generate a list instead.';
    } else {
      setStatus('Set your filters and generate a list to begin.');
    }
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
  if(isRateLimitModalOpen()){
    if(e.key === 'Escape') closeRateLimitModal();
    return;
  }
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
