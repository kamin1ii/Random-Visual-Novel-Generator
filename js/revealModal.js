import { els } from './dom.js?v=41';

// Self-contained "confirm before revealing explicit art" flow, kept separate from
// main.js so that file stays about wiring filters/navigation, not also owning a modal
// and a localStorage-backed setting.

// localStorage, not `state`, since this is a one-time device preference that should
// survive a page reload rather than reset with the rest of the browsing session.
const REMEMBER_REVEAL_KEY = 'vnpicker.rememberRevealExplicit';

function revealIsRemembered(){
  try{ return localStorage.getItem(REMEMBER_REVEAL_KEY) === 'true'; }
  catch(err){ return false; } // private browsing / storage disabled
}

// single place that writes the preference, so the modal checkbox, the footer checkbox,
// and Reset Filters can't drift out of sync with each other
function setRememberReveal(remembered){
  try{
    if(remembered) localStorage.setItem(REMEMBER_REVEAL_KEY, 'true');
    else localStorage.removeItem(REMEMBER_REVEAL_KEY);
  }catch(err){}
  els.revealPrefCheckbox.checked = !remembered; // footer checkbox reads "Ask before revealing", the inverse framing
}

function revealCover(){
  els.cover.classList.remove('sensitive');
  els.revealBtn.classList.remove('show');
}

function openRevealModal(){
  els.revealRemember.checked = false;
  els.revealModal.classList.add('open');
}

export function closeRevealModal(){
  els.revealModal.classList.remove('open');
}

export function isRevealModalOpen(){
  return els.revealModal.classList.contains('open');
}

export function resetRevealPreference(){
  setRememberReveal(false);
}

export function initRevealModal(){
  els.revealBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // otherwise this click also advances to the next entry
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

  els.revealModal.addEventListener('click', (e) => {
    if(e.target === els.revealModal) closeRevealModal(); // backdrop only, not the dialog itself
  });

  els.revealPrefCheckbox.checked = !revealIsRemembered();
  els.revealPrefCheckbox.addEventListener('change', () => {
    setRememberReveal(!els.revealPrefCheckbox.checked);
  });
}
