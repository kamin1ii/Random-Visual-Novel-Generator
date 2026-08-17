// Shared show/close/isOpen/backdrop-click wiring for every modal on the site. An
// optional cancelBtn turns it into a two-way Cancel/Confirm choice (revealModal,
// neverBlurModal), omitting it makes it a single-button dismiss (noResultsModal,
// rateLimitModal, vndbApiModal), everything else about the two shapes is identical.
export function makeModal(modalEl, confirmBtn, { cancelBtn, onOpen, onConfirm } = {}){
  function close(){ modalEl.classList.remove('open'); }
  function show(){ onOpen?.(); modalEl.classList.add('open'); }
  function isOpen(){ return modalEl.classList.contains('open'); }

  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // otherwise this click also advances to the next entry
    onConfirm?.();
    close();
  });
  if(cancelBtn){
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
  }
  modalEl.addEventListener('click', (e) => {
    if(e.target === modalEl) close(); // backdrop only, not the dialog itself
  });

  return { show, close, isOpen };
}
