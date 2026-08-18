import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReleaseFlags } from '../db/refresh-vndb-db.mjs';

function makeVn(){
  return {
    released_year: null,
    has_en_lang: 0,
    platforms: new Set(),
    languages: new Set(),
    has_en_release_complete: 0,
    has_en_release_any: 0,
    has_en_mtl: 0,
  };
}

const PAST = '20200115'; // a real, already-out date
const FUTURE = '20991231'; // announced but not out yet, VNDB's dump would represent this as TBA in practice

describe('deriveReleaseFlags', () => {
  test('a released, non-MTL English complete release sets every English flag', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST]];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    const vn = vnById.get('v1');
    assert.equal(vn.has_en_lang, 1);
    assert.equal(vn.has_en_release_any, 1);
    assert.equal(vn.has_en_release_complete, 1);
    assert.equal(vn.has_en_mtl, 0);
  });

  // Real bug: a VN's only non-MTL English release was an unofficial fan patch still
  // "in-progress" per its own notes, released=TBA. Its rtype (complete) and language
  // (en, non-MTL) looked identical to a real release, but VNDB excludes anything not
  // actually released yet from vn.languages, keyed on the release date, not rtype.
  test('an announced but unreleased (TBA) release never sets has_en_lang, even if complete and non-MTL', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', 'TBA']];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    assert.equal(vnById.get('v1').has_en_lang, 0);
  });

  test('a sentinel far-future 8 digit date is also treated as not released', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', FUTURE]];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    const vn = vnById.get('v1');
    assert.equal(vn.has_en_lang, 0);
    assert.equal(vn.released_year, null, 'a not-yet-out release must never produce a garbage release year');
  });

  test('a trial release never sets has_en_lang, matching VNDB\'s own c_languages formula', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST]];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'trial']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    assert.equal(vnById.get('v1').has_en_lang, 0);
  });

  test('a machine translated English release sets has_en_mtl but not has_en_lang', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST]];
    const relTitleRows = [['r1', 'en', 't']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    const vn = vnById.get('v1');
    assert.equal(vn.has_en_mtl, 1);
    assert.equal(vn.has_en_lang, 0);
    assert.equal(vn.has_en_release_any, 0, 'an MTL-only release is not a real English release either');
  });

  // Real bug: has_en_release_complete/any were gated on ANY English title existing on a
  // release (hasEn, MTL included) rather than a non-MTL one specifically, and completeness
  // was checked independently of which release actually had the non-MTL English text. A VN
  // with a partial non-MTL patch on one release and an unrelated complete MTL-only release
  // on another satisfied both flags despite no single release being both complete and
  // non-MTL English, confirmed empirically that VNDB's own release-level filter agrees,
  // querying for lang=en AND rtype=complete on such a VN returns zero results live.
  test('completeness and non-MTL English must come from the same release, not two different ones', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [
      ['rPartial', '', '', PAST],
      ['rCompleteMtl', '', '', PAST],
    ];
    const relTitleRows = [
      ['rPartial', 'en', 'f'],       // non-MTL English, but only a partial release
      ['rCompleteMtl', 'en', 't'],   // complete, but only as a machine translation
    ];
    const relVnRows = [
      ['rPartial', 'v1', 'partial'],
      ['rCompleteMtl', 'v1', 'complete'],
    ];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    const vn = vnById.get('v1');
    assert.equal(vn.has_en_release_any, 1, 'the partial non-MTL release alone is enough for "any"');
    assert.equal(vn.has_en_release_complete, 0, 'no single release is both complete and non-MTL English');
  });

  test('a real single release that is both complete and non-MTL sets has_en_release_complete', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST]];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    assert.equal(vnById.get('v1').has_en_release_complete, 1);
  });

  // Deliberate site policy, stricter than VNDB's own live API, which does not check
  // released<=today on its release-level lang filter (confirmed empirically, a TBA
  // release with rtype=complete still matched it live).
  test('has_en_release_any requires the release to have actually come out, not just be announced', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', 'TBA']];
    const relTitleRows = [['r1', 'en', 'f']];
    const relVnRows = [['r1', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, [], relVnRows);
    assert.equal(vnById.get('v1').has_en_release_any, 0);
  });

  test('released_year takes the earliest year across multiple releases', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [
      ['rOld', '', '', '20100601'],
      ['rNew', '', '', '20200101'],
    ];
    const relVnRows = [
      ['rOld', 'v1', 'complete'],
      ['rNew', 'v1', 'complete'],
    ];
    deriveReleaseFlags(vnById, releaseRows, [], [], relVnRows);
    assert.equal(vnById.get('v1').released_year, 2010);
  });

  // Real bug (v61100): a trial demo chapter released in the past made this VN pass the
  // baseline released_year IS NOT NULL filter even though its actual complete release is
  // still TBA. VNDB's own site correctly treats it as unreleased, since its vn-level
  // released date is computed the same way, excluding trial releases.
  test('a trial release with a past date does not set released_year on its own', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [
      ['rTrial', '', '', '20251216'],
      ['rComplete', '', '', 'TBA'],
    ];
    const relVnRows = [
      ['rTrial', 'v1', 'trial'],
      ['rComplete', 'v1', 'complete'],
    ];
    deriveReleaseFlags(vnById, releaseRows, [], [], relVnRows);
    assert.equal(vnById.get('v1').released_year, null);
  });

  test('a real complete release still sets released_year even when a trial release also exists', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [
      ['rTrial', '', '', '20200101'],
      ['rComplete', '', '', '20210601'],
    ];
    const relVnRows = [
      ['rTrial', 'v1', 'trial'],
      ['rComplete', 'v1', 'complete'],
    ];
    deriveReleaseFlags(vnById, releaseRows, [], [], relVnRows);
    assert.equal(vnById.get('v1').released_year, 2021, 'the earlier trial date must not be picked over the later real release');
  });

  test('languages and platforms accumulate across every release the VN has', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST], ['r2', '', '', PAST]];
    const relTitleRows = [['r1', 'ja', 'f'], ['r2', 'en', 'f']];
    const relPlatformRows = [['r1', 'win'], ['r2', 'mac']];
    const relVnRows = [['r1', 'v1', 'complete'], ['r2', 'v1', 'complete']];
    deriveReleaseFlags(vnById, releaseRows, relTitleRows, relPlatformRows, relVnRows);
    const vn = vnById.get('v1');
    assert.deepEqual([...vn.languages].sort(), ['en', 'ja']);
    assert.deepEqual([...vn.platforms].sort(), ['mac', 'win']);
  });

  test('a release row for a VN not present in vnById is skipped without throwing', () => {
    const vnById = new Map([['v1', makeVn()]]);
    const releaseRows = [['r1', '', '', PAST]];
    const relVnRows = [['r1', 'v-unknown', 'complete']];
    assert.doesNotThrow(() => deriveReleaseFlags(vnById, releaseRows, [], [], relVnRows));
  });
});
