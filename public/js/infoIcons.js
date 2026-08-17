// Compact stand-in for a subnote paragraph: a small "ⓘ" that shows its description in a
// tooltip on hover (mouse) or click/tap (touch, and mouse too) instead of the description
// always taking up its own line.
//
// position:fixed and JS-tracked, the same technique tagPicker.js's .suggest dropdown
// already uses, since these icons sit inside .sidebar-fields' scrolling box on desktop
// and a plain CSS-positioned tooltip would risk being clipped by that scroll boundary
// depending on where the icon happens to be scrolled to. That alone isn't enough though:
// .sidebar is position:sticky, and sticky unconditionally creates its own stacking
// context regardless of z-index, so a tooltip left nested inside it stays trapped
// competing for z-index only within that context, capped by wherever .sidebar itself
// falls in paint order against .main-col, no z-index value can win that fight from
// inside. Each tooltip gets moved to be a direct child of <body> once, up front, escaping
// that ancestor stacking context entirely rather than trying to out-z-index it.
export function initInfoIcons(){
  const icons = document.querySelectorAll('.info-icon');
  const tooltips = new Map(); // icon -> its tooltip, captured before reparenting moves it out from under the icon

  icons.forEach(icon => {
    const tooltip = icon.querySelector('.info-tooltip');
    tooltips.set(icon, tooltip);
    document.body.appendChild(tooltip);
  });

  function position(icon, tooltip){
    const rect = icon.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8);
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';
  }

  function open(icon){
    icons.forEach(i => { if(i !== icon) close(i); });
    const tooltip = tooltips.get(icon);
    tooltip.classList.add('open'); // added before measuring, offsetWidth is 0 while display:none
    position(icon, tooltip);
  }

  function close(icon){
    tooltips.get(icon).classList.remove('open');
  }

  icons.forEach(icon => {
    icon.addEventListener('mouseenter', () => open(icon));
    icon.addEventListener('mouseleave', () => close(icon));
    // Always opens rather than toggling. A click on a tabindex=0 element also focuses it,
    // and focus used to independently call open() too, so a single real click fired focus
    // (open) then click (which saw it already open and closed it again), needing a second
    // click to actually see anything. Keyboard activation moved to its own keydown handler
    // below instead, so open() only ever has one path in per input type, nothing left to race.
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      open(icon);
    });
    icon.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        open(icon);
      }
    });
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
    const openIcon = Array.from(icons).find(i => tooltips.get(i).classList.contains('open'));
    if(!openIcon || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      position(openIcon, tooltips.get(openIcon));
      scrollRaf = null;
    });
  }, true);
}
