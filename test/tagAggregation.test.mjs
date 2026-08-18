import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTagVoteRows, buildDirectParents, buildVnTagsWithHierarchy } from '../db/refresh-vndb-db.mjs';

// tags_vn row shape, positions read by aggregateTagVoteRows: [_, tag, vid, _, vote, spoiler, ignore]
function voteRow({ tag, vid, vote, spoiler = null, ignore = 'f' }){
  return ['id', tag, vid, 'uid', String(vote), spoiler === null ? null : String(spoiler), ignore];
}

const vnById = new Map([['v1', {}], ['v2', {}]]);

describe('aggregateTagVoteRows', () => {
  // The real bug: a title clearly tagged "Nukige" on VNDB's live site (visible, spoiler 0)
  // had zero rows for that tag locally, because the old code kept a tag only when its
  // magnitude-weighted average vote was positive. A few strongly negative votes can
  // outweigh many mildly positive ones in an average even though more people voted it up
  // than down, VNDB's real rule (SUM(sign(vote)) > 0) only counts net direction, not size.
  test('sign sum can be positive while the raw average is negative (the Nukige case)', () => {
    const rows = [
      voteRow({ tag: 'g100', vid: 'v1', vote: -3 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: -3 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1 }),
    ];
    const agg = aggregateTagVoteRows(rows, vnById);
    const entry = agg.get('v1|g100');
    const rawAverage = (-3 - 3 + 1 + 1 + 1 + 1 + 1) / 7;
    assert.ok(rawAverage < 0, 'sanity check, the raw average really is negative here');
    assert.equal(entry.signSum, 3, 'net of 5 positive voters against 2 negative ones');
    assert.ok(entry.signSum > 0, 'VNDB keeps this tag on signSum > 0, not average > 0');
  });

  test('a vote flagged ignore is excluded from the aggregate', () => {
    const rows = [
      voteRow({ tag: 'g100', vid: 'v1', vote: 1, ignore: 't' }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1, ignore: 'f' }),
    ];
    const agg = aggregateTagVoteRows(rows, vnById);
    assert.equal(agg.get('v1|g100').voteCount, 1);
  });

  test('votes are counted for a VN regardless of anything in the unread columns (e.g. a lie flag)', () => {
    // aggregateTagVoteRows never reads a "lie" column at all, VNDB's own query only
    // filters on ignore, lie is tracked as a separate aggregate elsewhere and never
    // removes a voter's contribution here.
    const rows = [voteRow({ tag: 'g100', vid: 'v1', vote: 1 })];
    const agg = aggregateTagVoteRows(rows, vnById);
    assert.equal(agg.get('v1|g100').voteCount, 1);
  });

  test('a vote for a VN not present in vnById is skipped entirely', () => {
    const rows = [voteRow({ tag: 'g100', vid: 'v999-unknown', vote: 1 })];
    const agg = aggregateTagVoteRows(rows, vnById);
    assert.equal(agg.size, 0);
  });

  test('spoiler sum and count only include votes with a spoiler rating actually set', () => {
    const rows = [
      voteRow({ tag: 'g100', vid: 'v1', vote: 1, spoiler: 2 }),
      voteRow({ tag: 'g100', vid: 'v1', vote: 1, spoiler: null }),
    ];
    const agg = aggregateTagVoteRows(rows, vnById);
    const entry = agg.get('v1|g100');
    assert.equal(entry.spoilerCount, 1);
    assert.equal(entry.spoilerSum, 2);
    assert.equal(entry.voteCount, 2, 'both votes still count toward signSum/voteCount regardless of spoiler');
  });
});

describe('buildVnTagsWithHierarchy', () => {
  const noMeta = new Set();
  const noParents = buildDirectParents([]);

  test('a tag with signSum <= 0 is dropped entirely, even with votes on it', () => {
    const tagAgg = new Map([['v1|g100', { signSum: 0, voteCount: 4, spoilerSum: 0, spoilerCount: 0 }]]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), noParents);
    assert.equal(vnTags.length, 0);
  });

  // The real bug: "Completely Unavoidable Heroine Death" is defaultspoil 2, being tagged
  // with it is inherently a major spoiler by definition even before anyone explicitly
  // rates it as one. A vote with no spoiler rating set (spoilerCount 0) must not silently
  // become spoiler 0.
  test('falls back to the tag\'s own defaultspoil when nobody set an explicit spoiler rating', () => {
    const tagAgg = new Map([['v1|g500', { signSum: 2, voteCount: 2, spoilerSum: 0, spoilerCount: 0 }]]);
    const defaultSpoilByTagId = new Map([['500', 2]]); // "Completely Unavoidable Heroine Death"
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, defaultSpoilByTagId, noParents);
    assert.equal(vnTags.find(t => t.tag_id === '500').spoiler, 2);
  });

  test('a tag with no defaultspoil entry falls back to 0, not undefined', () => {
    const tagAgg = new Map([['v1|g100', { signSum: 2, voteCount: 2, spoilerSum: 0, spoilerCount: 0 }]]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), noParents);
    assert.equal(vnTags.find(t => t.tag_id === '100').spoiler, 0);
  });

  // VNDB's exact CASE expression: avg > 1.3 -> 2, avg > 0.4 -> 1, else 0. Both boundary
  // values belong to the lower bucket, "> 1.3" and "> 0.4" are strict, not >=.
  test('an average spoiler rating of exactly 1.3 is level 1, not 2 (strict inequality)', () => {
    const tagAgg = new Map([['v1|g100', { signSum: 2, voteCount: 2, spoilerSum: 1.3, spoilerCount: 1 }]]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), noParents);
    assert.equal(vnTags.find(t => t.tag_id === '100').spoiler, 1);
  });

  test('an average spoiler rating just above 1.3 is level 2', () => {
    const tagAgg = new Map([['v1|g100', { signSum: 2, voteCount: 2, spoilerSum: 1.4, spoilerCount: 1 }]]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), noParents);
    assert.equal(vnTags.find(t => t.tag_id === '100').spoiler, 2);
  });

  test('an average spoiler rating of exactly 0.4 is level 0, not 1 (strict inequality)', () => {
    const tagAgg = new Map([['v1|g100', { signSum: 2, voteCount: 2, spoilerSum: 0.4, spoilerCount: 1 }]]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), noParents);
    assert.equal(vnTags.find(t => t.tag_id === '100').spoiler, 0);
  });

  test('a directly tagged child also propagates the tag to its ancestors', () => {
    const tagAgg = new Map([['v1|g300', { signSum: 2, voteCount: 2, spoilerSum: 0, spoilerCount: 0 }]]);
    const parents = buildDirectParents([['g300', 'g200'], ['g200', 'g100']]); // 300 -> 200 -> 100
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), parents);
    const tagIds = vnTags.map(t => t.tag_id).sort();
    assert.deepEqual(tagIds, ['100', '200', '300']);
  });

  test('a meta (category header) tag id is excluded even when it is a real ancestor', () => {
    const tagAgg = new Map([['v1|g300', { signSum: 2, voteCount: 2, spoilerSum: 0, spoilerCount: 0 }]]);
    const parents = buildDirectParents([['g300', 'g1']]); // 1 = "Theme", a meta tag
    const metaTagIds = new Set([1]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, metaTagIds, new Map(), parents);
    assert.equal(vnTags.some(t => t.tag_id === '1'), false);
    assert.equal(vnTags.some(t => t.tag_id === '300'), true);
  });

  test('when a tag is both directly voted and inherited from a sibling, the least restrictive spoiler level wins', () => {
    const tagAgg = new Map([
      ['v1|g100', { signSum: 2, voteCount: 2, spoilerSum: 3, spoilerCount: 2 }], // direct, spoiler 2
      ['v1|g300', { signSum: 2, voteCount: 2, spoilerSum: 0, spoilerCount: 2 }], // spoiler 0, ancestor is g100
    ]);
    const parents = buildDirectParents([['g300', 'g100']]);
    const vnTags = buildVnTagsWithHierarchy(tagAgg, noMeta, new Map(), parents);
    assert.equal(vnTags.find(t => t.tag_id === '100').spoiler, 0, 'the non-spoiler inherited entry wins over the direct spoiler-2 one');
  });
});
