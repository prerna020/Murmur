import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftAudioUri, parseDraft } from '../src/services/draftSchema.ts';

const review = {
  stage: 'review',
  sttEngine: 'android_ondevice_hi',
  rawTranscript: 'आज office गया',
  initialTranscript: 'aaj office gaya',
  editedTranscript: 'aaj office gayi',
  mood: 'calm',
  tags: ['work_study'],
  audioLengthMs: 12000,
  sttMs: 300,
  tempAudioUri: null,
  recordedAt: 1_700_000_000_000,
};

describe('entry draft schema', () => {
  it('accepts a review draft and a transcribing draft', () => {
    assert.ok(parseDraft(review));
    const transcribing = parseDraft({
      stage: 'transcribing',
      sttEngine: 'whisper_small_en',
      audioUri: 'file:///cache/AudioStream/stream-1.wav',
      audioLengthMs: 30000,
      recordedAt: 1,
    });
    assert.ok(transcribing);
    assert.strictEqual(draftAudioUri(transcribing), 'file:///cache/AudioStream/stream-1.wav');
  });

  it('rejects malformed drafts instead of throwing', () => {
    assert.strictEqual(parseDraft(null), null);
    assert.strictEqual(parseDraft({ ...review, mood: 'excited' }), null);
    assert.strictEqual(parseDraft({ ...review, tags: ['a', 'b', 'c', 'd'] }), null);
    assert.strictEqual(parseDraft({ ...review, stage: 'unknown' }), null);
  });

  it('reports no protected audio for a Hindi review draft', () => {
    assert.strictEqual(draftAudioUri(parseDraft(review)), null);
    assert.strictEqual(draftAudioUri(null), null);
  });
});
