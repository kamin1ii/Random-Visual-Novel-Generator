// Kept as one shared object rather than separate variables so every module can import
// the same reference and mutate it directly (state.list = results), instead of passing
// state around as function arguments everywhere.
export const state = {
  includeTags: [],
  excludeTags: [{ id: 214, name: 'Nukige' }], // excluded by default, removable via the chip's × like any other tag
  includeMode: 'and',
  excludeMode: 'or',
  lengths: new Set(),
  list: [],
  index: 0,
  isPlaceholder: true // true for the starter pick shown before the user generates a real list
};

// tagPicker.js's makeTagPicker() closures capture state.includeTags/excludeTags by
// reference at setup time in main.js, and push/splice into that exact reference on every
// add or remove. Clearing has to go through these functions, which mutate in place
// (length = 0), rather than state.includeTags = [], which would silently swap in a new
// array the picker closures never see and leave them pushing into an array nothing else reads.
export function clearIncludeTags(){
  state.includeTags.length = 0;
}
export function clearExcludeTags(){
  state.excludeTags.length = 0;
}
