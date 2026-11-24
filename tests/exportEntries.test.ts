import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntriesExport } from '../src/services/exportEntries.ts';
import type { JournalEntry } from '../src/types/journal';

describe('entries export', () => {
  it('includes every stored field and marks the file as not encrypted', () => {
    const entry: JournalEntry = {
      id: 'e1',
      createdAt: Date.UTC(2026, 10, 20),
      updatedAt: Date.UTC(2026, 10, 21),
      rawTranscript: 'आज office',
      sttEngine: 'android_ondevice_hi',
      correctedTranscript: 'aaj office',
      moodSelection: null,
      tags: ['work_study', 'coffee'],
      tagStatus: 'ok',
      metrics: { audioLengthMs: 1000, sttMs: 200, llmMs: 300, retryCount: 0 },
    };
    const parsed = JSON.parse(buildEntriesExport([entry], new Date(Date.UTC(2026, 10, 22))));
    assert.strictEqual(parsed.entryCount, 1);
    assert.match(parsed.note, /Not encrypted/);
    assert.deepStrictEqual(parsed.entries[0].tags, ['work_study', 'coffee']);
    assert.strictEqual(parsed.entries[0].rawTranscript, 'आज office');
    assert.strictEqual(parsed.entries[0].mood, null);
    assert.strictEqual(parsed.entries[0].createdAt, '2026-11-20T00:00:00.000Z');
  });
});
