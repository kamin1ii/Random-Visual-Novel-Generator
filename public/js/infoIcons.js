// Compact stand-in for a subnote paragraph: a small "ⓘ" that shows its description in a
// tooltip on click/tap instead of the description always taking up its own line. Click
// rather than hover as the trigger, deliberately, hover doesn't exist on a touchscreen at
// all, so a hover-only tooltip (the previous approach, using the native title attribute)
// never had any way to be triggered there in the first place. Click works identically for
// a mouse click and a touch tap, one code path covers both.
//
// position:fixed and JS tracked, the same technique tagPicker.js's .suggest dropdown
// already uses, since these icons sit inside .sidebar-fields' scrolling box on desktop
// and a plain CSS positioned tooltip would risk being clipped by that scroll boundary
// depending on where the icon happens to be scrolled to.
export function initInfoIcons(){
  const icons = document.querySelectorAll('.info-icon');

  function position(icon, tooltip){
    const rect = icon.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8);
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';
  }

  function open(icon){
    icons.forEach(close);
    const tooltip = icon.querySelector('.info-tooltip');
    tooltip.classList.add('open'); // added before measuring, offsetWidth is 0 while display:none
    position(icon, tooltip);
  }

  function close(icon){
    icon.querySelector('.info-tooltip').classList.remove('open');
  }

  function isOpen(icon){
    return icon.querySelector('.info-tooltip').classList.contains('open');
  }

  icons.forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      if(isOpen(icon)) close(icon);
      else open(icon);
    });
    icon.addEventListener('focus', () => open(icon));
    icon.addEventListener('blur', () => close(icon));
  });

  document.addEventListener('click', () => icons.forEach(close));
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape') icons.forEach(close);
  });

  // Repositions on scroll instead of closing, so the tooltip stays anchored to its icon.
  // capture:true catches both page scroll and the sidebar's internal scroll, since scroll
  // doesn't bubble to window normally. rAF-throttled since scroll can fire faster than repaints.
  let scrollRaf = null;
  document.addEventListener('scroll', () => {
    const openIcon = Array.from(icons).find(isOpen);
    if(!openIcon || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      position(openIcon, openIcon.querySelector('.info-tooltip'));
      scrollRaf = null;
    });
  }, true);
}
