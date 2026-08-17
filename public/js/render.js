import { els } from './dom.js?v=55';
import { state } from './state.js?v=53';
import { PLATFORM_LABELS, LENGTH_LABELS } from './constants.js?v=53';
import { showCover, preloadAround, resetPreloadDirection, markWentBackward } from './coverImage.js?v=58';
import { loadTags } from './tagPicker.js?v=53';

export { resetPreloadDirection, markWentBackward };

// D1 only returns {id, spoiler} per tag (names live in tags.json, already loaded
// client side for search, no reason to duplicate that data server side). VNDB's live
// API already returns full {name, category, spoiler, rating} objects directly, so this
// has no effect for that path, detected by whether name is already present.
async function resolveTags(rawTags){
  if(!Array.isArray(rawTags) || !rawTags.length) return [];
  if(rawTags[0].name !== undefined) return rawTags;

  const allTags = await loadTags();
  const byId = new Map(allTags.map(t => [String(t.id), t]));
  return rawTags.map(t => {
    const meta = byId.get(String(t.id));
    return {
      id: t.id,
      spoiler: t.spoiler,
      name: meta ? meta.name : 'Unknown tag',
      category: meta ? meta.category : 'cont',
      rating: 0, // tags.json and D1 don't carry per-VN tag strength, only VNDB's live API does
    };
  });
}

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

  const nonSpoilerTags = vn.tags.filter(t => t.category === 'cont' && t.spoiler === 0);

  // Spoiler flagged tags the person specifically searched for (include or exclude)
  // are shown anyway, picking that tag themselves already means they know about it,
  // this doesn't reveal anything they didn't already ask for. Every other spoiler tag
  // stays hidden. No extra VNDB call needed, spoiler flagged tags are already present
  // in the same response, just filtered out of view by default.
  // Our local tags.json stores bare integer IDs (214), but VNDB's live API returns tag
  // IDs as prefixed strings in VN responses ("g214"), comparing them directly would
  // never match, stripping any leading letters normalizes both sides to the same format.
  function normalizeTagId(id){
    return String(id).replace(/^\D+/, '');
  }

  const selectedTagIds = new Set([...state.includeTags, ...state.excludeTags].map(t => normalizeTagId(t.id)));
  const selectedSpoilerTags = vn.tags.filter(t =>
    t.category === 'cont' && t.spoiler > 0 && selectedTagIds.has(normalizeTagId(t.id))
  );

  const tags = [...nonSpoilerTags, ...selectedSpoilerTags]
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
    allLink.textContent = 'All tags on VNDB';
    allLink.addEventListener('click', (e) => e.stopPropagation());
    els.tagRow.appendChild(allLink);
  }

  draw();
}

let tagRenderToken = 0;

export async function showCurrent(){
  const vn = state.list[state.index];
  if(!vn) return;
  const myToken = ++tagRenderToken;

  els.counter.textContent = (state.index + 1) + ' / ' + state.list.length;

  els.titleMain.textContent = vn.title || 'Untitled';
  els.titleAlt.textContent = (vn.alttitle && vn.alttitle !== vn.title) ? vn.alttitle : '';

  showCover(vn);

  renderStats(vn);
  els.vndbLink.href = 'https://vndb.org/' + vn.id;
  els.coverLink.href = 'https://vndb.org/' + vn.id;
  els.synopsis.textContent = cleanDescription(vn.description);

  preloadAround(state.list, state.index);

  const resolvedTags = await resolveTags(vn.tags);
  if(myToken !== tagRenderToken) return; // a newer navigation already took over, don't overwrite its tags with stale ones
  renderTags({ ...vn, tags: resolvedTags });
}
