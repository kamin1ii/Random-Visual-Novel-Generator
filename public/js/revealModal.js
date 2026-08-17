import { els } from './dom.js?v=55';
import { state } from './state.js?v=53';
import { SENSITIVE_THRESHOLD } from './constants.js?v=53';

// Self contained "confirm before revealing explicit art" flow, kept separate from
// main.js so that file stays about wiring filters/navigation, not also owning a modal
// and a localStorage backed setting.

// localStorage, not `state`, since these are one time device preferences that should
// survive a page reload rather than reset with the rest of the browsing session.
const REMEMBER_REVEAL_KEY = 'vnpicker.rememberRevealExplicit';
const NEVER_BLUR_KEY = 'vnpicker.neverBlurExplicit';

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

// coverImage.js checks this directly (see isSensitive there) so a never blurred cover
// never gets the .sensitive class or a reveal button in the first place, rather than
// this module having to reach into another module's rendering to undo it after the fact.
export function neverBlurIsEnabled(){
  try{ return localStorage.getItem(NEVER_BLUR_KEY) === 'true'; }
  catch(err){ return false; }
}

function setNeverBlur(enabled){
  try{
    if(enabled) localStorage.setItem(NEVER_BLUR_KEY, 'true');
    else localStorage.removeItem(NEVER_BLUR_KEY);
  }catch(err){}
  els.blurExplicitCheckbox.checked = !enabled; // checkbox reads "Blur explicit images", the inverse framing
  // "Ask before revealing" has nothing left to ask about once nothing ever blurs
  els.revealPrefCheckbox.disabled = enabled;
}

function revealCover(){
  els.cover.classList.remove('sensitive');
  els.revealBtn.classList.remove('show');
}

// Mirrors the isSensitive check coverImage.js runs on every showCover() call, just aimed
// at the VN already on screen instead of the next one about to be shown. Needed because
// turning blurring back on doesn't run showCover() again by itself, without this the card on
// screen would stay unblurred until the next Next/Prev click happened to redraw it.
function reblurCurrentIfSensitive(){
  const vn = state.list[state.index];
  if(!vn || !vn.image) return;
  const isSensitive = vn.image.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD;
  if(isSensitive){
    els.cover.classList.add('sensitive');
    els.revealBtn.classList.add('show');
  }
}

// Same open/close/backdrop-click/Cancel-Confirm shape both modals in this file share
// (and the same shape main.js's own makeModal() covers for its single-OK modals), kept
// as one factory instead of writing the wiring out twice.
function makeConfirmModal(modalEl, cancelBtn, confirmBtn, { onOpen, onConfirm } = {}){
  function close(){ modalEl.classList.remove('open'); }
  function open(){ onOpen?.(); modalEl.classList.add('open'); }
  function isOpen(){ return modalEl.classList.contains('open'); }

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // otherwise this click also advances to the next entry
    close();
  });
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onConfirm?.();
    close();
  });
  modalEl.addEventListener('click', (e) => {
    if(e.target === modalEl) close(); // backdrop only, not the dialog itself
  });

  return { open, close, isOpen };
}

// Set inside initRevealModal, once the controller it delegates to actually exists.
// closeRevealModal/isRevealModalOpen stay as stable exported functions either way, so
// main.js's import binding never sees a reassignment, just this reaching further in.
let revealModalCtl = null;

export function closeRevealModal(){
  revealModalCtl?.close();
}

export function isRevealModalOpen(){
  return revealModalCtl?.isOpen() ?? false;
}

export function initRevealModal(){
  revealModalCtl = makeConfirmModal(els.revealModal, els.revealCancel, els.revealConfirm, {
    onOpen: () => { els.revealRemember.checked = false; },
    onConfirm: () => {
      if(els.revealRemember.checked) setRememberReveal(true);
      revealCover();
    },
  });

  els.revealBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // otherwise this click also advances to the next entry
    if(revealIsRemembered()){
      revealCover();
    } else {
      revealModalCtl.open();
    }
  });

  els.revealPrefCheckbox.checked = !revealIsRemembered();
  els.revealPrefCheckbox.addEventListener('change', () => {
    setRememberReveal(!els.revealPrefCheckbox.checked);
  });

  // Unchecking (turning blur off) needs a confirmation, it skips the warning entirely on
  // every title, no asking per image. Checking it again (turning blur back on) doesn't, undoing
  // a safety default isn't something that needs to be defended against.
  const neverBlurModal = makeConfirmModal(els.neverBlurModal, els.neverBlurCancel, els.neverBlurConfirm, {
    onConfirm: () => {
      setNeverBlur(true);
      revealCover(); // the card on screen right now shouldn't stay blurred behind a setting that just turned blurring off
    },
  });

  els.blurExplicitCheckbox.checked = !neverBlurIsEnabled();
  els.revealPrefCheckbox.disabled = neverBlurIsEnabled();
  els.blurExplicitCheckbox.addEventListener('change', () => {
    if(!els.blurExplicitCheckbox.checked){
      els.blurExplicitCheckbox.checked = true; // stays blurred until actually confirmed
      neverBlurModal.open();
    } else {
      setNeverBlur(false);
      reblurCurrentIfSensitive();
    }
  });
}
