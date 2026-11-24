import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasDevanagari,
  convertDevanagariToHinglish,
  stripThinkTags,
} from '../src/services/hinglishTransliteration.ts';

describe('Hinglish Transliteration Service', () => {
  it('detects Devanagari script correctly', () => {
    assert.strictEqual(hasDevanagari('हाँ भाई'), true);
    assert.strictEqual(hasDevanagari('Hello this is pure English'), false);
    assert.strictEqual(hasDevanagari('han bhai office ka kaam'), false);
  });

  it('transliterates the exact user sentence to natural Roman Hinglish', () => {
    const input = 'हाँ भाई ऑफिस का काम बहुत ज्यादा है';
    const output = convertDevanagariToHinglish(input);

    assert.strictEqual(output, 'haan bhai office ka kaam bahut zyada hai');
  });

  it('restores English words properly (never writes "aayi" for "I")', () => {
    const input = 'आई वेंट टू ऑफिस फॉर मीटिंग विद टीम';
    const output = convertDevanagariToHinglish(input);

    assert.ok(output.includes('I'), `Expected 'I' in: ${output}`);
    assert.ok(output.includes('office'), `Expected 'office' in: ${output}`);
    assert.ok(output.includes('meeting'), `Expected 'meeting' in: ${output}`);
    assert.ok(output.includes('team'), `Expected 'team' in: ${output}`);
    assert.strictEqual(output.includes('aayi'), false);
    assert.strictEqual(output.includes('miting'), false);
  });

  it('transliterates complex mixed Hinglish sentences without translating', () => {
    const input = 'आज टीम के साथ मीटिंग में बहुत अच्छा डिस्कशन हुआ';
    const output = convertDevanagariToHinglish(input);

    assert.strictEqual(
      output,
      'aaj team ke saath meeting mein bahut achha discussion hua'
    );
  });

  it('strips <think> tags completely and prevents reasoning leakage', () => {
    const leakedOutput =
      '<think>\nThis is internal model reasoning\nMapping words...\n</think>\nहाँ भाई काम है';
    const output = convertDevanagariToHinglish(leakedOutput);

    assert.strictEqual(output.includes('<think>'), false);
    assert.strictEqual(output.includes('reasoning'), false);
    assert.strictEqual(output, 'haan bhai kaam hai');
  });

  it('never swaps a Latin word the recognizer returned for a "nearest" word', () => {
    // These were rewritten by the removed snapToVocabulary step.
    const text = 'mitting prajekt dedlain office kaam';
    assert.strictEqual(convertDevanagariToHinglish(text), text);
  });

  it('keeps Latin words as returned inside mixed-script output', () => {
    const input = 'आज office में mitting थी';
    const output = convertDevanagariToHinglish(input);
    assert.ok(output.includes('office'), `Expected 'office' in: ${output}`);
    assert.ok(output.includes('mitting'), `Expected 'mitting' kept in: ${output}`);
    assert.strictEqual(hasDevanagari(output), false);
  });

  it('transliterates an unknown Devanagari word letter by letter, without substitution', () => {
    // प्रजेक्ट is not in the dictionary. Before, it was snapped to "project".
    const output = convertDevanagariToHinglish('प्रजेक्ट');
    assert.notStrictEqual(output, 'project');
    assert.strictEqual(hasDevanagari(output), false);
  });

  it('converts the English words reported from the phone', () => {
    // "because", "not", "is", "life" as returned by the hi-IN recognizer
    assert.strictEqual(convertDevanagariToHinglish('बिकॉज़ नॉट इज़ लाइफ'), 'because not is life');
    // Same words with the nukta written as a separate mark
    assert.strictEqual(convertDevanagariToHinglish('बिकॉज\u093C इज\u093C'), 'because is');
  });

  it('never leaves Devanagari in the output for vowel signs, nukta, danda or digits', () => {
    const inputs = ['कॉन्टेक्ट', 'बॅट', 'ऑनलाइन', 'फ़ैसला', 'ज़िंदगी', 'ठीक है।', 'साल २०२६', 'ॐ'];
    for (const input of inputs) {
      const output = convertDevanagariToHinglish(input);
      assert.strictEqual(hasDevanagari(output), false, `Devanagari left in "${output}" for "${input}"`);
    }
    assert.strictEqual(convertDevanagariToHinglish('ठीक है।'), 'theek hai.');
    assert.strictEqual(convertDevanagariToHinglish('साल २०२६'), 'saal 2026');
  });

  it('treats precomposed and decomposed nukta letters the same', () => {
    assert.strictEqual(
      convertDevanagariToHinglish('\u095Bयादा'),
      convertDevanagariToHinglish('ज\u093Cयादा')
    );
  });

  it('leaves purely English/Latin text untouched', () => {
    const text = 'Today was a great day at office.';
    assert.strictEqual(convertDevanagariToHinglish(text), text);
  });
});
