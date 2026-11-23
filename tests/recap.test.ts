import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeeklyRecap, getWeekDateRange } from '../src/services/recap.ts';
import type { JournalEntry } from '../src/types/journal';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function createMockEntry(overrides: Partial<JournalEntry>): JournalEntry {
  return {
    id: `mock_${Math.random().toString(36).substring(2, 9)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rawTranscript: 'Sample raw transcript',
    sttEngine: 'whisper_small_en',
    correctedTranscript: 'Sample corrected transcript',
    moodSelection: 'happy',
    tags: ['work_study'],
    tagStatus: 'ok',
    metrics: {
      audioLengthMs: 5000,
      sttMs: 400,
      llmMs: 200,
      retryCount: 0,
    },
    ...overrides,
  };
}

describe('Weekly Recap Counting Logic', () => {
  const refTime = new Date('2026-11-10T12:00:00Z');
  const nowMs = refTime.getTime();
  const startDate = new Date(nowMs - 7 * ONE_DAY_MS);
  const endDate = refTime;

  it('handles empty weeks correctly (0 entries)', () => {
    const recap = computeWeeklyRecap([], startDate, endDate, 'Test Week');

    assert.strictEqual(recap.entryCount, 0);
    assert.strictEqual(recap.hasFewerThanThree, true);
    assert.deepStrictEqual(recap.tagCounts, []);
    assert.deepStrictEqual(recap.moodCounts, []);
  });

  it('handles entries with no tags', () => {
    const entries: JournalEntry[] = [
      createMockEntry({
        createdAt: nowMs - 2 * ONE_DAY_MS,
        tags: [],
        moodSelection: 'calm',
      }),
      createMockEntry({
        createdAt: nowMs - 3 * ONE_DAY_MS,
        tags: [],
        moodSelection: 'happy',
      }),
    ];

    const recap = computeWeeklyRecap(entries, startDate, endDate);

    assert.strictEqual(recap.entryCount, 2);
    assert.strictEqual(recap.hasFewerThanThree, true);
    assert.deepStrictEqual(recap.tagCounts, []);
    assert.strictEqual(recap.moodCounts.length, 2);
    assert.deepStrictEqual(
      recap.moodCounts.find((m) => m.mood === 'calm'),
      { mood: 'calm', count: 1 }
    );
    assert.deepStrictEqual(
      recap.moodCounts.find((m) => m.mood === 'happy'),
      { mood: 'happy', count: 1 }
    );
  });

  it('handles entries with no mood (counted strictly as "not set", never inferred)', () => {
    const entries: JournalEntry[] = [
      createMockEntry({
        createdAt: nowMs - 1 * ONE_DAY_MS,
        moodSelection: null,
        rawTranscript: 'I felt so joyful and excited today',
        correctedTranscript: 'I felt so joyful and excited today',
        tags: ['health'],
      }),
      createMockEntry({
        createdAt: nowMs - 2 * ONE_DAY_MS,
        moodSelection: null,
        rawTranscript: 'I was very angry and frustrated',
        correctedTranscript: 'I was very angry and frustrated',
        tags: ['work_study'],
      }),
    ];

    const recap = computeWeeklyRecap(entries, startDate, endDate);

    assert.strictEqual(recap.entryCount, 2);
    // Mood counts must strictly register as "not set", even though text has emotional words
    const notSetMood = recap.moodCounts.find((m) => m.mood === 'not set');
    assert.ok(notSetMood, 'Expected "not set" category in moodCounts');
    assert.strictEqual(notSetMood?.count, 2);
    // Ensure no other moods were inferred
    assert.strictEqual(recap.moodCounts.length, 1);
  });

  it('tallies and sorts custom tags alongside standard topic tags', () => {
    const entries: JournalEntry[] = [
      createMockEntry({
        createdAt: nowMs - 1 * ONE_DAY_MS,
        tags: ['work_study', 'chai-session', 'project-x'],
        moodSelection: 'neutral',
      }),
      createMockEntry({
        createdAt: nowMs - 2 * ONE_DAY_MS,
        tags: ['chai-session', 'health'],
        moodSelection: 'happy',
      }),
      createMockEntry({
        createdAt: nowMs - 3 * ONE_DAY_MS,
        tags: ['chai-session', 'work_study'],
        moodSelection: 'happy',
      }),
    ];

    const recap = computeWeeklyRecap(entries, startDate, endDate);

    assert.strictEqual(recap.entryCount, 3);
    assert.strictEqual(recap.hasFewerThanThree, false);

    // chai-session: 3 times
    // work_study: 2 times
    // health: 1 time
    // project-x: 1 time
    assert.strictEqual(recap.tagCounts[0].tag, 'chai-session');
    assert.strictEqual(recap.tagCounts[0].count, 3);

    assert.strictEqual(recap.tagCounts[1].tag, 'work_study');
    assert.strictEqual(recap.tagCounts[1].count, 2);

    const healthTag = recap.tagCounts.find((t) => t.tag === 'health');
    assert.strictEqual(healthTag?.count, 1);

    const projectTag = recap.tagCounts.find((t) => t.tag === 'project-x');
    assert.strictEqual(projectTag?.count, 1);
  });

  it('correctly sets hasFewerThanThree flag', () => {
    const twoEntries = [
      createMockEntry({ createdAt: nowMs - 1 * ONE_DAY_MS }),
      createMockEntry({ createdAt: nowMs - 2 * ONE_DAY_MS }),
    ];
    assert.strictEqual(
      computeWeeklyRecap(twoEntries, startDate, endDate).hasFewerThanThree,
      true
    );

    const threeEntries = [
      ...twoEntries,
      createMockEntry({ createdAt: nowMs - 3 * ONE_DAY_MS }),
    ];
    assert.strictEqual(
      computeWeeklyRecap(threeEntries, startDate, endDate).hasFewerThanThree,
      false
    );
  });

  it('filters out entries outside the selected week date range', () => {
    const entries: JournalEntry[] = [
      // Within window (now - 2 days)
      createMockEntry({
        id: 'in_1',
        createdAt: nowMs - 2 * ONE_DAY_MS,
        tags: ['in_range'],
      }),
      // Older than 7 days (now - 9 days) -> should be excluded
      createMockEntry({
        id: 'out_old',
        createdAt: nowMs - 9 * ONE_DAY_MS,
        tags: ['old_entry'],
      }),
      // Future entry (now + 1 day) -> should be excluded
      createMockEntry({
        id: 'out_future',
        createdAt: nowMs + 1 * ONE_DAY_MS,
        tags: ['future_entry'],
      }),
    ];

    const recap = computeWeeklyRecap(entries, startDate, endDate);

    assert.strictEqual(recap.entryCount, 1);
    assert.strictEqual(recap.tagCounts.length, 1);
    assert.strictEqual(recap.tagCounts[0].tag, 'in_range');
  });

  it('getWeekDateRange computes correct week intervals and labels', () => {
    const rangeCurrent = getWeekDateRange(0, refTime);
    assert.ok(rangeCurrent.label.startsWith('Last 7 Days'));
    assert.strictEqual(
      rangeCurrent.endDate.getTime() - rangeCurrent.startDate.getTime(),
      7 * ONE_DAY_MS
    );

    const rangePrev = getWeekDateRange(1, refTime);
    assert.ok(rangePrev.label.startsWith('1 Week Ago'));
    assert.strictEqual(rangePrev.endDate.getTime(), rangeCurrent.startDate.getTime());

    const rangeTwoWeeks = getWeekDateRange(2, refTime);
    assert.ok(rangeTwoWeeks.label.startsWith('2 Weeks Ago'));
    assert.strictEqual(rangeTwoWeeks.endDate.getTime(), rangePrev.startDate.getTime());
  });
});
