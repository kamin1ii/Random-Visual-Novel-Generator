import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLengthCategory, parseRawLengthCategory, imageIdToPath, unescapeTsvField, stripFormatting } from '../db/refresh-vndb-db.mjs';

describe('parseRawLengthCategory', () => {
  // Real bug: VNDB's dump uses the literal string "0" for "no length category set", not
  // "\N" like every other unset numeric field. "0" is truthy in JS, so a plain ternary let
  // it through as if it were a real category, and "length IN (1,2,3,4,5)" then silently
  // excluded every one of these VNs even with every length checkbox on, since SQL's IN
  // never matches a literal 0 against that list (it would if these were genuinely NULL).
  test('the literal string "0" means unset, not category 0', () => {
    assert.equal(parseRawLengthCategory('0'), null);
  });

  test('a real category string parses to its integer value', () => {
    assert.equal(parseRawLengthCategory('3'), 3);
  });

  test('an actually empty value stays null', () => {
    assert.equal(parseRawLengthCategory(null), null);
    assert.equal(parseRawLengthCategory(''), null);
  });
});

describe('deriveLengthCategory', () => {
  // Every boundary here was confirmed empirically against VNDB's own live length filter,
  // not assumed from the stated hour ranges, see the comment above the function itself.
  test('falls back to the raw category vote when length_minutes is null', () => {
    assert.equal(deriveLengthCategory(3, null), 3);
    assert.equal(deriveLengthCategory(null, null), null);
  });

  test('120 minutes (exactly 2 hours) still belongs to the lower bucket, Very short', () => {
    assert.equal(deriveLengthCategory(99, 120), 1);
  });

  test('121 minutes starts the next bucket, Short', () => {
    assert.equal(deriveLengthCategory(99, 121), 2);
  });

  test('600 minutes (exactly 10 hours) still belongs to Short', () => {
    assert.equal(deriveLengthCategory(99, 600), 2);
  });

  test('601 minutes starts Medium', () => {
    assert.equal(deriveLengthCategory(99, 601), 3);
  });

  test('1800 minutes (exactly 30 hours) still belongs to Medium', () => {
    assert.equal(deriveLengthCategory(99, 1800), 3);
  });

  test('1801 minutes starts Long', () => {
    assert.equal(deriveLengthCategory(99, 1801), 4);
  });

  test('3000 minutes (exactly 50 hours) still belongs to Long', () => {
    assert.equal(deriveLengthCategory(99, 3000), 4);
  });

  test('3001 minutes starts Very long', () => {
    assert.equal(deriveLengthCategory(99, 3001), 5);
  });

  // Regression test for the real title (v12150) that surfaced this bug, its raw category
  // vote said Medium (3) but VNDB's own site and live filter both treat its 3126 minute
  // playtime as Very long (5).
  test('a precise minute count overrides a disagreeing raw category vote (v12150)', () => {
    assert.equal(deriveLengthCategory(3, 3126), 5);
  });
});

describe('imageIdToPath', () => {
  test('turns a cv image id into the local mirror\'s folder layout', () => {
    assert.equal(imageIdToPath('cv20339'), 'cv/39/20339.jpg');
  });

  test('pads a folder name shorter than two digits', () => {
    assert.equal(imageIdToPath('cv5'), 'cv/05/5.jpg');
  });

  test('returns null for a falsy or non-cv image id', () => {
    assert.equal(imageIdToPath(null), null);
    assert.equal(imageIdToPath(''), null);
    assert.equal(imageIdToPath('sf12345'), null);
  });
});

describe('unescapeTsvField', () => {
  test('turns escaped sequences back into their real characters', () => {
    assert.equal(unescapeTsvField('line one\\nline two'), 'line one\nline two');
    assert.equal(unescapeTsvField('a\\tb'), 'a\tb');
    assert.equal(unescapeTsvField('a\\\\b'), 'a\\b');
  });

  test('a plain string with nothing to escape passes through unchanged', () => {
    assert.equal(unescapeTsvField('plain text'), 'plain text');
  });
});

describe('stripFormatting', () => {
  test('removes VNDB\'s bbcode-style url and spoiler tags but keeps the inner text', () => {
    assert.equal(stripFormatting('[url=https://example.com]a link[/url]'), 'a link');
    assert.equal(stripFormatting('[spoiler]a secret[/spoiler]'), 'a secret');
  });

  test('strips any other bracketed tag generically', () => {
    assert.equal(stripFormatting('plain [b]bold[/b] text'), 'plain bold text');
  });

  test('returns null for a falsy description', () => {
    assert.equal(stripFormatting(null), null);
    assert.equal(stripFormatting(''), null);
  });
});
