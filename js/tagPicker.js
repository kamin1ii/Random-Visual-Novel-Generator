import { vndbQuery } from './api.js?v=33';

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

// shared by both include/exclude inputs, same behavior, only the target array differs
export function makeTagPicker(inputEl, suggestEl, statusEl, listArr, chipsEl, chipClass){
  let timer = null;
  let results = [];
  let activeIndex = -1;

  // .suggest is position:fixed to escape the sidebar's own scroll clipping, so its
  // position has to be tracked here in JS instead of via static CSS.
  function positionSuggest(){
    const rect = inputEl.getBoundingClientRect();
    suggestEl.style.left = rect.left + 'px';
    suggestEl.style.top = (rect.bottom + 4) + 'px';
    suggestEl.style.width = rect.width + 'px';
  }

  // closes visually but keeps `results` cached, so refocusing without retyping can
  // instantly reopen instead of showing nothing until a new keystroke
  function hide(){
    suggestEl.classList.remove('open');
    suggestEl.innerHTML = '';
    activeIndex = -1;
  }

  function close(){ // full reset, used once the search context itself changes
    hide();
    results = [];
  }

  function highlight(){
    Array.from(suggestEl.children).forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  function pick(tag){
    if(!listArr.some(t => t.id === tag.id)){
      listArr.push({ id: tag.id, name: tag.name });
      renderChips(listArr, chipsEl, chipClass);
    }
    inputEl.value = '';
    statusEl.textContent = '';
    close();
    inputEl.focus();
  }

  function render(){
    suggestEl.innerHTML = '';
    const existing = new Set(listArr.map(t => t.id));
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
    results = filtered;
    positionSuggest();
    suggestEl.classList.add('open');
    highlight();
  }

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
    }, 300); // debounced, no request on every keystroke
  });

  // reopens on refocus if there's still text and cached results, e.g. click away then back
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

  document.addEventListener('click', (e) => {
    if(!suggestEl.contains(e.target) && e.target !== inputEl) hide();
  });

  // Repositions on scroll instead of closing, so the dropdown stays anchored to the
  // input. capture:true catches both page scroll and the sidebar's internal scroll,
  // since scroll doesn't bubble to window normally. Excludes the dropdown's own
  // results list scroll. rAF throttled since scroll can fire faster than repaints.
  let scrollRaf = null;
  window.addEventListener('scroll', (e) => {
    if(suggestEl.contains(e.target)) return;
    if(!suggestEl.classList.contains('open')) return;
    if(scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      positionSuggest();
      scrollRaf = null;
    });
  }, true);
}
