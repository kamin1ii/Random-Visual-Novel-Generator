import { vndbQuery } from './api.js?v=19';

export function renderChips(listArr, chipsEl, chipClass){
  chipsEl.innerHTML = '';
  listArr.forEach((tag, i) => {
    const span = document.createElement('span');
    span.className = 'chip ' + chipClass;
    span.innerHTML = tag.name + ' ';
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

  function close(){
    suggestEl.classList.remove('open');
    suggestEl.innerHTML = '';
    results = [];
    activeIndex = -1;
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
      suggestEl.classList.add('open');
      return;
    }
    filtered.forEach(tag => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = tag.name + '<small>' + tag.category + '</small>';
      btn.addEventListener('click', () => pick(tag));
      suggestEl.appendChild(btn);
    });
    results = filtered; // keep in sync with what's actually rendered, for keyboard nav indices
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
      close();
    }
  });

  // On the document rather than the input, since a click anywhere else on the page
  // (not just outside this specific field) should close the dropdown.
  document.addEventListener('click', (e) => {
    if(!suggestEl.contains(e.target) && e.target !== inputEl) close();
  });
}
