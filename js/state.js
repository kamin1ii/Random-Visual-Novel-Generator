// Kept as one shared object rather than separate variables so every module can import
// the same reference and mutate it directly (state.list = results), instead of passing
// state around as function arguments everywhere.
export const state = {
  includeTags: [],
  excludeTags: [],
  includeMode: 'and',
  excludeMode: 'or',
  lengths: new Set(),
  list: [],
  index: 0,
  isPlaceholder: true // true for the starter pick shown before the user generates a real list
};
