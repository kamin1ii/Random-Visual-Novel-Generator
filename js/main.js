import { els } from './dom.js?v=15';
import { state } from './state.js?v=15';
import { runQuery } from './api.js?v=15';
import { buildFilters, describeFilters } from './filters.js?v=15';
import { makeTagPicker, renderChips } from './tagPicker.js?v=15';
import { showCurrent, setStatus, renderActiveFilters } from './render.js?v=15';

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
  // While the reveal-confirmation modal is open, arrow keys shouldn't advance the card
  // behind it, and Escape should close the modal rather than doing nothing.
  if(els.revealModal.classList.contains('open')){
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

// "Remember" is stored in localStorage (not `state`) specifically so it survives a page
// reload, it's a one-time device preference rather than something tied to the current
// browsing session the way everything else in `state` is.
const REMEMBER_REVEAL_KEY = 'vnpicker.rememberRevealExplicit';

function revealIsRemembered(){
  try{ return localStorage.getItem(REMEMBER_REVEAL_KEY) === 'true'; }
  catch(err){ return false; } // private browsing / storage disabled, fall back to always asking
}

// Single place that changes the stored preference, so the modal's checkbox, the
// persistent footer checkbox, and Reset Filters can never drift out of sync with
// each other, whichever one of them the person actually used to change it.
function setRememberReveal(remembered){
  try{
    if(remembered) localStorage.setItem(REMEMBER_REVEAL_KEY, 'true');
    else localStorage.removeItem(REMEMBER_REVEAL_KEY);
  }catch(err){} // best-effort, ignore if storage is blocked
  // The footer checkbox reads "Ask before revealing", the positive/opposite framing of
  // "remembered", so its checked state is always the inverse of the stored value.
  els.revealPrefCheckbox.checked = !remembered;
}

function revealCover(){
  els.cover.classList.remove('sensitive');
  els.revealBtn.classList.remove('show');
}

function openRevealModal(){
  els.revealRemember.checked = false;
  els.revealModal.classList.add('open');
}

function closeRevealModal(){
  els.revealModal.classList.remove('open');
}

els.revealBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // otherwise this click would also advance to the next entry
  if(revealIsRemembered()){
    revealCover();
  } else {
    openRevealModal();
  }
});

els.revealCancel.addEventListener('click', (e) => {
  e.stopPropagation();
  closeRevealModal();
});

els.revealConfirm.addEventListener('click', (e) => {
  e.stopPropagation();
  if(els.revealRemember.checked) setRememberReveal(true);
  revealCover();
  closeRevealModal();
});

// Clicking the dimmed backdrop (not the dialog box itself) closes the modal the same
// way Cancel does, e.target === els.revealModal only matches the backdrop, not children.
els.revealModal.addEventListener('click', (e) => {
  if(e.target === els.revealModal) closeRevealModal();
});

// The persistent footer checkbox mirrors the same preference (inverted, since it reads
// "Ask before revealing" rather than "remember my choice"), so it can be turned back on
// directly without needing to hunt for the reveal modal or use Reset Filters.
els.revealPrefCheckbox.checked = !revealIsRemembered();
els.revealPrefCheckbox.addEventListener('change', () => {
  setRememberReveal(!els.revealPrefCheckbox.checked);
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
  setRememberReveal(false); // back to asking before each explicit reveal
  setStatus('Filters reset. Generate a list to begin.');
});

loadInitialPick();
