import { vndbQuery } from './api.js?v=29';

export function renderChips(listArr, chipsEl, chipClass){
  chipsEl.innerHTML = '';
  listArr.forEach((tag, i) => {
    const span = document.createElement('span');
    span.className = 'chip ' + chipClass;
    span.textContent = tag.name + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.setAttribute('aria-label', 'Remove ' + tag.name);
    btn.addEventListener('click', () => {
      listArr.splice(i, 1);
      renderChips(listArr, chipsEl, chipClass);
    });
    span.appendChild(btn);
    chipsEl.appendChild(span);
  });
}

// Shared by both the include and exclude inputs, since the search/suggest/pick behavior
// is identical for both, only the target array and styling differ.
export function makeTagPicker(inputEl, suggestEl, statusEl, listArr, chipsEl, chipClass){
  let timer = null;
  let results = [];
  let activeIndex = -1; // -1 means nothing highlighted for keyboard nav

  // .suggest is position:fixed so it isn't clipped by the sidebar's own scroll boundary,
  // which means its position has to be set here in JS (tracking the input's current
  // on-screen location) rather than via static CSS relative to a positioned ancestor.
  function positionSuggest(){
    const rect = inputEl.getBoundingClientRect();
    suggestEl.style.left = rect.left + 'px';
    suggestEl.style.top = (rect.bottom + 4) + 'px';
    suggestEl.style.width = rect.width + 'px';
  }

  // Visually closes without clearing the cached results, so refocusing the input
  // afterward (without retyping) can instantly reopen with what was already found,
  // rather than showing nothing until a new keystroke.
  function hide(){
    suggestEl.classList.remove('open');
    suggestEl.innerHTML = '';
    activeIndex = -1;
  }

  // A full reset, used when the search context itself changes (the query goes empty,
  // or a tag gets picked), where the old results genuinely don't apply anymore.
  function close(){
    hide();
    results = [];
  }

  function highlight(){
    Array.from(suggestEl.children).forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  function pick(tag){
    if(!listArr.some(t => t.id === tag.id)){ // avoid duplicate chips
      listArr.push({ id: tag.id, name: tag.name });
      renderChips(listArr, chipsEl, chipClass);
    }
    inputEl.value = '';
    statusEl.textContent = '';
    close();
    inputEl.focus(); // keeps the cursor ready to search for the next tag right away
  }

  function render(){
    suggestEl.innerHTML = '';
    const existing = new Set(listArr.map(t => t.id)); // don't suggest tags already picked
    const filtered = results.filter(r => !existing.has(r.id));
    if(!filtered.length){
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'No matching tag found';
      suggestEl.appendChild(div);
      positionSuggest();
      suggestEl.classList.add('open');
      return;
    }
    filtered.forEach(tag => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const nameSpan = document.createTextNode(tag.name);
      const catSmall = document.createElement('small');
      catSmall.textContent = tag.category;
      btn.appendChild(nameSpan);
      btn.appendChild(catSmall);
      btn.addEventListener('click', () => pick(tag));
      suggestEl.appendChild(btn);
    });
    results = filtered; // keep in sync with what's actually rendered, for keyboard nav indices
    positionSuggest();
    suggestEl.classList.add('open');
    highlight();
  }

  // Shown the instant typing starts, before the network request resolves, so it's clear
  // right away that this field expects a pick from a list rather than free typed text.
  function showLoading(){
    suggestEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Searching tags...';
    suggestEl.appendChild(div);
    positionSuggest();
    suggestEl.classList.add('open');
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    activeIndex = -1;
    if(q.length < 1){ close(); statusEl.textContent = ''; return; }
    results = [];
    showLoading();
    statusEl.textContent = '…';
    statusEl.className = 'tag-status spin';
    // debounced so a fast typer doesn't fire a request on every keystroke
    timer = setTimeout(async () => {
      try{
        const data = await vndbQuery('tag', { filters:["search","=",q], fields:"id,name,category", results:10 });
        results = data.results || [];
        statusEl.textContent = results.length ? '' : '';
        render();
      }catch(err){
        statusEl.textContent = '!';
        close();
      }
    }, 300);
  });

  // Reopens the dropdown when refocusing an input that already has text and cached
  // results from before, e.g. clicking away then clicking back in without retyping,
  // rather than leaving it closed with no way back in short of deleting a character.
  inputEl.addEventListener('focus', () => {
    if(inputEl.value.trim().length >= 1 && results.length){
      render();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if(!suggestEl.classList.contains('open')) return;
    if(e.key === 'ArrowDown'){
      e.preventDefault();
      if(results.length){ activeIndex = (activeIndex + 1) % results.length; highlight(); }
    } else if(e.key === 'ArrowUp'){
      e.preventDefault();
      if(results.length){ activeIndex = (activeIndex - 1 + results.length) % results.length; highlight(); }
    } else if(e.key === 'Enter'){
      e.preventDefault();
      if(results.length){ pick(results[activeIndex >= 0 ? activeIndex : 0]); }
    } else if(e.key === 'Escape'){
      hide();
    }
  });

  // On the document rather than the input, since a click anywhere else on the page
  // (not just outside this specific field) should close the dropdown.
  document.addEventListener('click', (e) => {
    if(!suggestEl.contains(e.target) && e.target !== inputEl) hide();
  });

  // The dropdown's fixed position is only correct at the moment it was set. Listening
  // on window with capture:true catches scrolling anywhere, the whole page scrolling
  // *and* the sidebar's own internal scroll, since scroll events don't bubble up to
  // window on their own, capture is what lets a single listener here catch both rather
  // than needing a separate one for every scrollable ancestor.
  window.addEventListener('scroll', hide, true);
}
