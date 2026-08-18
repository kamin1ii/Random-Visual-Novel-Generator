import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhereClause } from '../server/whereClause.js';

describe('buildWhereClause', () => {
  test('baseline with no filters set', () => {
    const { where, params } = buildWhereClause({});
    assert.equal(where, 'has_description = 1 AND released_year IS NOT NULL');
    assert.deepEqual(params, []);
  });

  test('minVotes adds a votecount condition', () => {
    const { where, params } = buildWhereClause({ minVotes: 10 });
    assert.match(where, /votecount >= \?/);
    assert.deepEqual(params, [10]);
  });

  test('minVotes of 0 is a no-op, matching every other empty-selection field', () => {
    const { where, params } = buildWhereClause({ minVotes: 0 });
    assert.doesNotMatch(where, /votecount/);
    assert.deepEqual(params, []);
  });

  test('minRating scales to VNDB\'s 0-100 range and clamps to a floor of 10', () => {
    const { where, params } = buildWhereClause({ minRating: 7 });
    assert.match(where, /rating >= \?/);
    assert.deepEqual(params, [70]);
  });

  test('minRating below 1.0 still clamps to 10, not a value below VNDB\'s meaningful floor', () => {
    const { params } = buildWhereClause({ minRating: 0.5 });
    assert.deepEqual(params, [10]);
  });

  test('maxRating adds an upper bound when below the 10 (Any) sentinel', () => {
    const { where, params } = buildWhereClause({ maxRating: 5 });
    assert.match(where, /rating <= \?/);
    assert.deepEqual(params, [50]);
  });

  test('maxRating of 10 (Any) is a no-op', () => {
    const { where, params } = buildWhereClause({ maxRating: 10 });
    assert.doesNotMatch(where, /rating <= \?/);
    assert.deepEqual(params, []);
  });

  test('minRating and maxRating combine into two independent bounds, in order', () => {
    const { where, params } = buildWhereClause({ minRating: 7, maxRating: 8 });
    const minIdx = where.indexOf('rating >= ?');
    const maxIdx = where.indexOf('rating <= ?');
    assert.ok(minIdx !== -1 && maxIdx !== -1);
    assert.ok(minIdx < maxIdx);
    assert.deepEqual(params, [70, 80]);
  });

  test('originalJapaneseOnly filters on olang', () => {
    const { where } = buildWhereClause({ originalJapaneseOnly: true });
    assert.match(where, /olang = 'ja'/);
  });

  test('englishOnly without MTL requires both language existence and completeness', () => {
    const { where } = buildWhereClause({ englishOnly: true });
    assert.match(where, /has_en_lang = 1/);
    assert.match(where, /has_en_release_complete = 1/);
  });

  test('englishOnly with includePartialEnglish relaxes completeness to any release', () => {
    const { where } = buildWhereClause({ englishOnly: true, includePartialEnglish: true });
    assert.match(where, /has_en_release_any = 1/);
    assert.doesNotMatch(where, /has_en_release_complete/);
  });

  test('englishOnly with includeMTL drops the non-MTL language existence check', () => {
    const { where } = buildWhereClause({ englishOnly: true, includeMTL: true });
    assert.doesNotMatch(where, /has_en_lang = 1/);
    assert.match(where, /has_en_release_complete = 1/);
  });

  test('year range adds both bounds when both are set', () => {
    const { where, params } = buildWhereClause({ yearFrom: 2015, yearTo: 2020 });
    assert.match(where, /released_year >= \?/);
    assert.match(where, /released_year <= \?/);
    assert.deepEqual(params, [2015, 2020]);
  });

  test('year range with only yearFrom set omits the upper bound', () => {
    const { where, params } = buildWhereClause({ yearFrom: 2015 });
    assert.match(where, /released_year >= \?/);
    assert.doesNotMatch(where, /released_year <= \?/);
    assert.deepEqual(params, [2015]);
  });

  test('a partial length selection emits an IN clause', () => {
    const { where, params } = buildWhereClause({ lengths: [1, 3] });
    assert.match(where, /length IN \(\?,\?\)/);
    assert.deepEqual(params, [1, 3]);
  });

  test('all five length boxes checked is a no-op, matching an empty selection', () => {
    const { where, params } = buildWhereClause({ lengths: [1, 2, 3, 4, 5] });
    assert.doesNotMatch(where, /length IN/);
    assert.deepEqual(params, []);
  });

  test('an empty length selection is also a no-op', () => {
    const { where, params } = buildWhereClause({ lengths: [] });
    assert.doesNotMatch(where, /length IN/);
    assert.deepEqual(params, []);
  });

  test('include tags default to AND across multiple tags with the strict spoiler cap', () => {
    const { where, params } = buildWhereClause({ includeTags: [{ id: 1 }, { id: 2 }] });
    const existsCount = (where.match(/EXISTS/g) || []).length;
    assert.equal(existsCount, 2);
    assert.doesNotMatch(where, / OR /);
    assert.deepEqual(params, ['1', 0, '2', 0]);
  });

  test('include tags switch to OR when includeMode is "or"', () => {
    const { where } = buildWhereClause({ includeTags: [{ id: 1 }, { id: 2 }], includeMode: 'or' });
    assert.match(where, / OR /);
  });

  test('hideSpoilerTagMatches set to false raises the spoiler cap to 2', () => {
    const { params } = buildWhereClause({ includeTags: [{ id: 1 }], hideSpoilerTagMatches: false });
    assert.deepEqual(params, ['1', 2]);
  });

  // excludeMode's naming describes what the person sees ("exclude if it has any one" vs
  // "exclude only if it has every one"), not the SQL join word used to build that, the
  // two are inverted from each other, confirmed against the actual query logic below
  // rather than guessed from the option name.
  test('default exclude mode excludes a VN that has any one of the tags (AND-joined NOT EXISTS)', () => {
    const { where } = buildWhereClause({ excludeTags: [{ id: 1 }, { id: 2 }] });
    const notExistsCount = (where.match(/NOT EXISTS/g) || []).length;
    assert.equal(notExistsCount, 2);
    assert.doesNotMatch(where, / OR /);
  });

  test('excludeMode "and" only excludes a VN that has every tag (OR-joined NOT EXISTS)', () => {
    const { where } = buildWhereClause({ excludeTags: [{ id: 1 }, { id: 2 }], excludeMode: 'and' });
    assert.match(where, / OR /);
  });
});
