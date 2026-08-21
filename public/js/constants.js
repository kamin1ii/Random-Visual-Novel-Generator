export const API = 'https://api.vndb.org/kana';

// VNDB requires every field to be named explicitly, there's no "give me everything" option.
export const VN_FIELDS = "title, alttitle, image.url, image.sexual, released, rating, votecount, length_minutes, length, description, tags.name, tags.category, tags.spoiler, tags.rating, platforms, languages";

// VNDB returns platform availability as short codes, this maps them to something readable.
export const PLATFORM_LABELS = {
  win:'PC', lin:'Linux', mac:'Mac', ps1:'PS1', ps2:'PS2', ps3:'PS3', ps4:'PS4', ps5:'PS5',
  psp:'PSP', psv:'PS Vita', and:'Android', ios:'iOS', web:'Web', swi:'Switch',
  n3d:'3DS', nds:'DS', drc:'Wii U', dvd:'DVD Player', bdp:'Blu-ray', dos:'DOS', xb1:'Xbox One',
  xxx:'Xbox 360', xxc:'Xbox', oth:'Other'
};

// VNDB's precise length_minutes isn't always available, this is the fallback 1-5 scale.
export const LENGTH_LABELS = {1:'very short',2:'short',3:'medium',4:'long',5:'very long'};

// Same thresholds VNDB itself computes length_minutes into this 1-5 scale with (confirmed
// empirically against VNDB's live API, see db/refresh-vndb-db.mjs). Shown in place of the
// bare category name whenever length_minutes itself isn't available, e.g. "10 - 30h
// playtime", matching the "52h playtime" phrasing used when a precise count does exist.
export const LENGTH_RANGES = {1:'< 2',2:'2 - 10',3:'10 - 30',4:'30 - 50',5:'> 50'};

// Covers scoring at or above this get blurred behind a reveal button rather than shown outright.
export const SENSITIVE_THRESHOLD = 1.2;

// Shared by coverImage.js (deciding a freshly shown cover's initial blur state) and
// revealModal.js (re-checking the cover already on screen when blurring gets turned back
// on), so the two can't independently drift on what "sensitive" means.
export function isSensitiveCover(vn){
  return vn.image?.sexual != null && vn.image.sexual >= SENSITIVE_THRESHOLD;
}

// VNDB's hard cap per request, anything larger has to be split across multiple calls.
export const PER_PAGE = 100;
