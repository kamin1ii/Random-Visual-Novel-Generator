import { els } from './dom.js?v=24';

// Self-contained "confirm before revealing explicit art" flow: the button that
// triggers it, the confirmation dialog, and the persistent "ask me / don't ask me"
// preference are all one cohesive concern, kept separate from main.js so that file
// stays about wiring the filters and navigation together rather than also owning
// a modal and a localStorage-backed setting.

// Stored in localStorage (not `state`) specifically so it survives a page reload, it's
// a one-time device preference rather than something tied to the current browsing
// session the way everything else in `state` is.
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

export function closeRevealModal(){
  els.revealModal.classList.remove('open');
}

export function isRevealModalOpen(){
  return els.revealModal.classList.contains('open');
}

// Used by main.js's Reset Filters handler alongside resetFilterUI(), so a reset also
// puts the reveal preference back to asking every time.
export function resetRevealPreference(){
  setRememberReveal(false);
}

// Called once from main.js at startup to wire up every event listener this module owns.
export function initRevealModal(){
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
}
