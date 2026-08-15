import { els } from './dom.js?v=36';
import { state } from './state.js?v=36';
import { PLATFORM_LABELS, LENGTH_LABELS } from './constants.js?v=36';
import { showCover, preloadAround } from './coverImage.js?v=36';

export function cleanDescription(raw){
  if(!raw) return 'No synopsis on file for this title.';
  let s = raw
    .replace(/\[url=[^\]]*\]/gi,'')
    .replace(/\[\/url\]/gi,'')
    .replace(/\[spoiler\]/gi,'').replace(/\[\/spoiler\]/gi,'')
    .replace(/\[[^\]]+\]/g,'') // any other VNDB formatting code
    .replace(/\r?\n+/g,' ')
    .replace(/\s{2,}/g,' ')
    .trim();
  return s || 'No synopsis on file for this title.';
}

export function setStatus(text){ els.statusLine.textContent = text; }

export function renderActiveFilters(parts){
  els.activeFilters.innerHTML = '';
  parts.forEach(text => {
    const span = document.createElement('span');
    span.className = 'filter-chip';
    span.textContent = text;
    els.activeFilters.appendChild(span);
  });
}

function renderStats(vn){
  els.statStrip.innerHTML = '';
  const chips = [];

  if(vn.rating != null) chips.push({ text: (vn.rating/10).toFixed(1) + ' / 10', cls:'rating' });
  if(vn.released) chips.push({ text: String(vn.released).slice(0,4) });

  if(vn.length_minutes){
    const h = Math.round(vn.length_minutes/60);
    chips.push({ text: h > 0 ? h + 'h playtime' : vn.length_minutes + 'm playtime' });
  } else if(vn.length){
    chips.push({ text: LENGTH_LABELS[vn.length] || '' }); // fallback when no precise minute count exists
  }

  if(Array.isArray(vn.platforms) && vn.platforms.length){
    chips.push({ text: vn.platforms.slice(0,3).map(p => PLATFORM_LABELS[p] || p.toUpperCase()).join(' · ') });
  }

  if(Array.isArray(vn.languages) && vn.languages.includes('en')){
    chips.push({ text: 'English available', cls:'lang' });
  }

  chips.filter(c => c.text).forEach(c => {
    const span = document.createElement('span');
    span.className = 'chip stat' + (c.cls ? ' ' + c.cls : '');
    span.textContent = c.text;
    els.statStrip.appendChild(span);
  });
}

const TAG_PREVIEW_COUNT = 6;

function renderTags(vn){
  els.tagRow.innerHTML = '';
  if(!Array.isArray(vn.tags)) return;

  const tags = vn.tags
    .filter(t => t.category === 'cont' && t.spoiler === 0)
    .sort((a,b) => (b.rating||0) - (a.rating||0));

  let expanded = false; // local to this render call, resets naturally on the next VN shown

  function draw(){
    els.tagRow.innerHTML = '';
    const shown = expanded ? tags : tags.slice(0, TAG_PREVIEW_COUNT);
    shown.forEach(t => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t.name;
      els.tagRow.appendChild(span);
    });

    const remaining = tags.length - TAG_PREVIEW_COUNT;
    if(remaining > 0){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag tag-more';
      btn.textContent = expanded ? 'Show less' : '+' + remaining + ' more';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        draw();
      });
      els.tagRow.appendChild(btn);
    }

    // always shown: the filter above drops technical/spoiler tags, so there can be more
    // on VNDB than this row ever displays, this is the way out instead of a dead end
    const allLink = document.createElement('a');
    allLink.className = 'tag tag-all-link';
    allLink.href = 'https://vndb.org/' + vn.id + '/tags#tags';
    allLink.target = '_blank';
    allLink.rel = 'noopener';
    allLink.textContent = 'All tags on VNDB ↗';
    allLink.addEventListener('click', (e) => e.stopPropagation());
    els.tagRow.appendChild(allLink);
  }

  draw();
}

export function showCurrent(){
  const vn = state.list[state.index];
  if(!vn) return;

  els.counter.textContent = (state.index + 1) + ' / ' + state.list.length;

  els.titleMain.textContent = vn.title || 'Untitled';
  els.titleAlt.textContent = (vn.alttitle && vn.alttitle !== vn.title) ? vn.alttitle : '';

  showCover(vn);

  renderStats(vn);
  renderTags(vn);
  els.vndbLink.href = 'https://vndb.org/' + vn.id;
  els.coverLink.href = 'https://vndb.org/' + vn.id;
  els.dialogue.textContent = cleanDescription(vn.description);

  preloadAround(state.list, state.index);
}
