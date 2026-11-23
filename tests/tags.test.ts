import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addTag, normalizeTag, MAX_TAG_LENGTH } from '../src/services/tags.ts';

describe('Tag rules', () => {
  it('trims, lowercases and strips a leading #', () => {
    assert.strictEqual(normalizeTag('  #Coffee  '), 'coffee');
    assert.strictEqual(normalizeTag('Morning Run'), 'morning run');
  });

  it('adds a valid tag without mutating the input', () => {
    const current = ['work_study'];
    const result = addTag(current, ' Gym ');
    assert.deepStrictEqual(result, { ok: true, tags: ['work_study', 'gym'] });
    assert.deepStrictEqual(current, ['work_study']);
  });

  it('rejects empty tags', () => {
    assert.strictEqual(addTag([], '   ').ok, false);
    assert.strictEqual(addTag([], '#').ok, false);
  });

  it(`rejects tags longer than ${MAX_TAG_LENGTH} characters`, () => {
    const exact = 'a'.repeat(MAX_TAG_LENGTH);
    assert.strictEqual(addTag([], exact).ok, true);
    const result = addTag([], 'a'.repeat(MAX_TAG_LENGTH + 1));
    assert.deepStrictEqual(result, { ok: false, tags: [], reason: 'too_long' });
  });

  it('rejects duplicates after normalization', () => {
    const result = addTag(['coffee'], '#COFFEE');
    assert.deepStrictEqual(result, { ok: false, tags: ['coffee'], reason: 'duplicate' });
  });

  it('keeps at most 3 tags in total', () => {
    const full = ['work_study', 'health', 'gym'];
    const result = addTag(full, 'coffee');
    assert.deepStrictEqual(result, { ok: false, tags: full, reason: 'limit' });
  });
});
