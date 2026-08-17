import { els } from './dom.js?v=55';
import { state } from './state.js?v=53';
import { runQuery, fetchRandomPool, runQueryD1, fetchDbInfo } from './api.js?v=53';
import { buildFilters, describeFilters, gatherFilterState } from './filters.js?v=53';
import { resetFilterUI } from './filterControls.js?v=53';
import { makeTagPicker, renderChips } from './tagPicker.js?v=53';
import { showCurrent, setStatus, renderActiveFilters, resetPreloadDirection, markWentBackward } from './render.js?v=53';
import { initRevealModal, closeRevealModal, isRevealModalOpen } from './revealModal.js?v=55';
import { initInfoIcons } from './infoIcons.js?v=54';

initInfoIcons();

makeTagPicker(els.includeInput, els.includeSuggest, els.includeStatus, state.includeTags, els.includeChips, 'include');
makeTagPicker(els.excludeInput, els.excludeSuggest, els.excludeStatus, state.excludeTags, els.excludeChips, 'exclude');
// renders the default Nukige chip on load, chip rendering otherwise only happens on
// add/remove/reset, without this the exclude filter would be silently active with no
// visible chip until the person reset filters once
renderChips(state.includeTags, els.includeChips, 'include');
renderChips(state.excludeTags, els.excludeChips, 'exclude');

// one small reusable modal helper instead of writing the same show/close/isOpen/
// click-outside logic out twice, only the no-results modal needs a dynamic message
function makeModal(modalEl, okBtn){
  function show(){ modalEl.classList.add('open'); }
  function close(){ modalEl.classList.remove('open'); }
  function isOpen(){ return modalEl.classList.contains('open'); }
  okBtn.addEventListener('click', close);
  modalEl.addEventListener('click', (e) => {
    if(e.target === modalEl) close();
  });
  return { show, close, isOpen };
}

const noResultsModal = makeModal(els.noResultsModal, els.noResultsOk);
const rateLimitModal = makeModal(els.rateLimitModal, els.rateLimitOk);
const vndbApiModal = makeModal(els.vndbApiModal, els.vndbApiOk);

// shows every time the box is checked, not just once, same disclaimer the info-icon
// tooltip next to it already gives, just surfaced more forcefully since it's easy to
// miss a tooltip that only opens on hover/click
els.useVndbApi.addEventListener('change', () => {
  if(els.useVndbApi.checked) vndbApiModal.show();
});

function showNoResultsModal(message){
  els.noResultsBody.textContent = message;
  noResultsModal.show();
}

let rateLimitedUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 90000;

function startRateLimitCooldown(){
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  rateLimitModal.show();
}

async function generateList(){
  if(Date.now() < rateLimitedUntil){
    rateLimitModal.show(); // still cooling down, re-show without calling VNDB again
    return;
  }
  els.generateBtn.disabled = true;
  const useVndb = els.useVndbApi.checked;
  setStatus(useVndb ? 'Searching VNDB…' : 'Searching…');
  try{
    const listSize = parseInt(els.listSize.value, 10);
    const { count, results, debug } = useVndb
      ? await runQuery(buildFilters(), listSize)
      : await runQueryD1(gatherFilterState(), listSize);
    if(debug){
      console.log(`server generate: cache ${debug.cacheHit ? 'HIT' : 'MISS'} on count, ${debug.queryMs}ms query time`);
    }
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
    resetPreloadDirection();
    setStatus(count.toLocaleString() + ' titles match. Showing ' + results.length + ' of them.');
    renderActiveFilters(describeFilters());
    els.prevBtn.disabled = false;
    els.nextBtn.disabled = false;
    showCurrent();
  }catch(err){
    if(err.status === 429){
      startRateLimitCooldown();
      setStatus('Rate limit reached. Wait a minute or two before trying again.');
    } else {
      setStatus(err.message || 'Something went wrong.');
    }
  }finally{
    els.generateBtn.disabled = false;
  }
}

// runs on page load, before anyone's touched a filter
async function loadInitialPick(){
  const useVndb = els.useVndbApi.checked;
  try{
    let results;
    if(useVndb){
      // tag 214 = Nukige, excluded server-side so this doesn't need a pool to filter
      // locally, one candidate is enough since VNDB already guarantees it isn't nukige
      const filters = ["and", ["has_description","=",1], ["votecount",">=",10], ["olang","=","ja"], ["tag","!=",[214,2,0]]];
      ({ results } = await fetchRandomPool(filters, 1));
    } else {
      const filterState = { minVotes: 10, originalJapaneseOnly: true, excludeTags: [{ id: 214 }], hideSpoilerTagMatches: true };
      ({ results } = await runQueryD1(filterState, 1));
    }
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
      setStatus('Please wait a minute or two before generating another list.');
      els.titleMain.textContent = 'Rate limited';
      els.titleAlt.textContent = '';
      els.synopsis.textContent = 'The rate limit was reached while loading a starting pick. This isn\u2019t a missing cover. Nothing was fetched yet. Please wait a minute or two before generating another list.';
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
  markWentBackward();
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
  if(rateLimitModal.isOpen()){
    if(e.key === 'Escape') rateLimitModal.close();
    return;
  }
  if(noResultsModal.isOpen()){
    if(e.key === 'Escape') noResultsModal.close();
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
  setStatus('Filters reset. Generate a list to begin.');
});

loadInitialPick();

fetchDbInfo().then(info => {
  if(info.dumpTimestamp){
    // stored value already carries its own UTC offset (e.g. "2026-08-16 08:00:10+00"),
    // strip it rather than blindly appending 'Z', which produced an invalid double-suffix
    // string ("...+00Z") that some engines silently parse as Invalid Date
    const iso = info.dumpTimestamp.replace(' ', 'T').replace(/[+-]\d{2}(:?\d{2})?$/, '') + 'Z';
    const d = new Date(iso);
    els.dbLastUpdated.textContent = 'Database dump last updated ' + d.toLocaleDateString() + '.';
  }
});
