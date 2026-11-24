import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentWords, findCandidatePairs } from '../src/services/insightPairs.ts';
import {
  checkInsightReply,
  findExcerptRange,
  generateWeeklyInsight,
  isInsightStillValid,
  isVerbatimExcerpt,
  weekFingerprint,
  MAX_INSIGHT_WORDS,
} from '../src/services/insight.ts';
import type { JournalEntry } from '../src/types/journal';
import type { LlmCallResult, LlmCallStats } from '../src/services/tagSuggestion.ts';
import { createSyntheticEntries } from '../src/services/syntheticEntries.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 16, 12);

function entry(id: string, day: number, text: string, tags: string[]): JournalEntry {
  return {
    id,
    createdAt: T0 + day * DAY,
    updatedAt: T0 + day * DAY,
    rawTranscript: text,
    sttEngine: null,
    correctedTranscript: text,
    moodSelection: null,
    tags,
    tagStatus: 'none',
    metrics: { audioLengthMs: 0, sttMs: 0, llmMs: 0, retryCount: 0 },
  };
}

// Synthetic examples
const demoPrep = entry(
  'demo1',
  0,
  'Spent the evening preparing slides for the client demo on Thursday, nervous about the pricing section.',
  ['work_study']
);
const demoDone = entry(
  'demo2',
  2,
  'Client demo happened today, the pricing section went fine and the client asked for a follow-up.',
  ['work_study']
);
// Same tag, different event: shares the tag but no meaningful words.
const appraisal = entry(
  'appr',
  1,
  'Manager scheduled my appraisal for next month, I hope the salary hike is decent.',
  ['work_study']
);
// Same words, different tag: must not pair with the demo entries.
const friendDemo = entry(
  'friend',
  3,
  'Watched my friend practise her client demo pricing pitch at the cafe.',
  ['relationships']
);
const hinglishA = entry(
  'hi1',
  1,
  'Aaj mummy ki tabiyat kharab thi, doctor appointment book kiya Saturday ke liye.',
  ['family', 'health']
);
const hinglishB = entry(
  'hi2',
  4,
  'Saturday ko mummy ko doctor ke paas le gaya, tabiyat ab better hai.',
  ['family']
);

describe('contentWords', () => {
  it('drops English and Hinglish stop words and short words', () => {
    const words = contentWords('Aaj mummy ki tabiyat kharab thi aur the doctor is here');
    assert.deepStrictEqual([...words].sort(), ['doctor', 'kharab', 'mummy', 'tabiyat']);
  });
});

describe('findCandidatePairs', () => {
  const week = [demoPrep, appraisal, demoDone, friendDemo, hinglishA, hinglishB];
  const pairs = findCandidatePairs(week);

  it('pairs entries that share a tag and meaningful words', () => {
    const ids = pairs.map((p) => `${p.a.id}+${p.b.id}`);
    assert.ok(ids.includes('demo1+demo2'));
    assert.ok(ids.includes('hi1+hi2'));
  });

  it('excludes same-tag-different-event pairs', () => {
    const involvesAppraisal = pairs.some((p) => p.a.id === 'appr' || p.b.id === 'appr');
    assert.strictEqual(involvesAppraisal, false);
  });

  it('excludes shared words without a shared tag', () => {
    const involvesFriend = pairs.some((p) => p.a.id === 'friend' || p.b.id === 'friend');
    assert.strictEqual(involvesFriend, false);
  });

  it('keeps at most 3 pairs, older entry first, best overlap first', () => {
    assert.ok(pairs.length <= 3);
    for (const p of pairs) assert.ok(p.a.createdAt <= p.b.createdAt);
    for (let i = 1; i < pairs.length; i++) {
      assert.ok(pairs[i - 1].sharedWords.length >= pairs[i].sharedWords.length);
    }
  });
});

const demoPair = findCandidatePairs([demoPrep, demoDone])[0];

function reply(obj: unknown): string {
  return JSON.stringify(obj);
}

const goodReply = reply({
  supported: true,
  insight: 'The client demo you prepared for on Monday went fine, including the pricing section you were nervous about.',
  evidence: [
    { entryId: 'A', excerpt: 'nervous about the pricing   SECTION' },
    { entryId: 'B', excerpt: 'the pricing section went fine' },
  ],
});

describe('checkInsightReply', () => {
  it('accepts verbatim excerpts, normalizing only whitespace and case', () => {
    const check = checkInsightReply(goodReply, demoPair);
    assert.strictEqual(check.kind, 'insight');
    if (check.kind === 'insight') {
      assert.deepStrictEqual(
        check.insight.evidence.map((e) => e.entryId),
        ['demo1', 'demo2']
      );
    }
  });

  it('treats {"supported": false} as a valid no-insight answer', () => {
    assert.deepStrictEqual(checkInsightReply('{"supported": false}', demoPair), { kind: 'unsupported' });
  });

  it('rejects a paraphrased excerpt', () => {
    const bad = reply({
      supported: true,
      insight: 'The demo went well.',
      evidence: [
        { entryId: 'A', excerpt: 'worried about pricing part' },
        { entryId: 'B', excerpt: 'the pricing section went fine' },
      ],
    });
    const check = checkInsightReply(bad, demoPair);
    assert.strictEqual(check.kind, 'invalid');
    if (check.kind === 'invalid') assert.match(check.problem, /not an exact quote from entry A/);
  });

  it('rejects two excerpts from the same entry', () => {
    const bad = reply({
      supported: true,
      insight: 'The demo went well.',
      evidence: [
        { entryId: 'B', excerpt: 'the pricing section went fine' },
        { entryId: 'B', excerpt: 'client asked for a follow-up' },
      ],
    });
    assert.strictEqual(checkInsightReply(bad, demoPair).kind, 'invalid');
  });

  it(`rejects an insight longer than ${MAX_INSIGHT_WORDS} words`, () => {
    const long = Array.from({ length: MAX_INSIGHT_WORDS + 1 }, () => 'word').join(' ');
    const bad = reply({
      supported: true,
      insight: long,
      evidence: [
        { entryId: 'A', excerpt: 'nervous about the pricing section' },
        { entryId: 'B', excerpt: 'the pricing section went fine' },
      ],
    });
    const check = checkInsightReply(bad, demoPair);
    assert.strictEqual(check.kind, 'invalid');
  });

  it('rejects one-word excerpts and malformed JSON', () => {
    const tiny = reply({
      supported: true,
      insight: 'Demo.',
      evidence: [
        { entryId: 'A', excerpt: 'pricing' },
        { entryId: 'B', excerpt: 'pricing' },
      ],
    });
    assert.strictEqual(checkInsightReply(tiny, demoPair).kind, 'invalid');
    assert.strictEqual(checkInsightReply('sure, here you go', demoPair).kind, 'invalid');
  });
});

const stats: LlmCallStats = {
  firstTokenMs: 1,
  totalMs: 1,
  tokensGenerated: 1,
  promptTokens: 1,
  prefillMs: 1,
  decodeMs: 1,
  finishReason: 'stop',
  rawChars: 1,
  answerChars: 1,
  hadThinkBlock: false,
  modelLoaded: true,
  modelSessionId: 1,
  callIndexInSession: 1,
};

function fakeModel(outputs: (string | Error)[]) {
  const prompts: string[] = [];
  const call = async (prompt: string): Promise<LlmCallResult> => {
    prompts.push(prompt);
    const next = outputs.shift();
    if (next === undefined) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return { text: next, stats };
  };
  return { call, prompts };
}

describe('generateWeeklyInsight', () => {
  const pairs = findCandidatePairs([demoPrep, demoDone, hinglishA, hinglishB]);

  it('stops at the first verified insight', async () => {
    const model = fakeModel([goodReply]);
    const result = await generateWeeklyInsight([demoPair], model.call);
    assert.ok(result.insight);
    assert.strictEqual(result.metrics.pairsTried, 1);
    assert.strictEqual(result.metrics.insightProduced, true);
  });

  it('retries once with the exact problem, then moves to the next pair', async () => {
    const paraphrase = reply({
      supported: true,
      insight: 'x',
      evidence: [
        { entryId: 'A', excerpt: 'not in the text at all' },
        { entryId: 'B', excerpt: 'also not in the text' },
      ],
    });
    const model = fakeModel([paraphrase, paraphrase, '{"supported": false}']);
    const result = await generateWeeklyInsight(pairs.slice(0, 2), model.call);
    assert.strictEqual(result.insight, null);
    assert.strictEqual(result.metrics.pairsTried, 2);
    assert.strictEqual(result.metrics.validationFailures, 2);
    assert.strictEqual(result.metrics.retries, 1);
    assert.strictEqual(result.metrics.unsupportedAnswers, 1);
    assert.strictEqual(result.metrics.proposedInsights, 2);
    assert.strictEqual(result.metrics.excerptFailures, 2);
    assert.match(model.prompts[1], /Your last reply was rejected: the excerpt for A/);
    assert.ok(!model.prompts[0].includes('rejected'));
  });

  it('sends only the two corrected transcripts of the pair', async () => {
    const model = fakeModel(['{"supported": false}']);
    await generateWeeklyInsight([demoPair], model.call);
    assert.ok(model.prompts[0].includes(demoPrep.correctedTranscript));
    assert.ok(model.prompts[0].includes(demoDone.correctedTranscript));
    assert.ok(!model.prompts[0].includes(appraisal.correctedTranscript));
    assert.ok(!model.prompts[0].includes(demoPrep.id));
  });

  it('returns no insight (and no throw) when every attempt fails', async () => {
    const model = fakeModel([new Error('busy'), new Error('busy')]);
    const result = await generateWeeklyInsight([demoPair], model.call);
    assert.strictEqual(result.insight, null);
    assert.strictEqual(result.metrics.insightProduced, false);
  });
});

describe('cache helpers', () => {
  it('marks an insight invalid once an edit breaks an excerpt', async () => {
    const check = checkInsightReply(goodReply, demoPair);
    assert.strictEqual(check.kind, 'insight');
    if (check.kind !== 'insight') return;
    assert.strictEqual(isInsightStillValid(check.insight, [demoPrep, demoDone]), true);
    const edited = { ...demoDone, correctedTranscript: 'Client demo was cancelled.', updatedAt: demoDone.updatedAt + 1 };
    assert.strictEqual(isInsightStillValid(check.insight, [demoPrep, edited]), false);
    assert.notStrictEqual(weekFingerprint([demoPrep, demoDone]), weekFingerprint([demoPrep, edited]));
  });

  it('finds the excerpt position in the original text for highlighting', () => {
    const text = 'Client demo happened today,  the Pricing\nsection went fine.';
    const range = findExcerptRange(text, 'the pricing section');
    assert.ok(range);
    if (!range) return;
    assert.strictEqual(text.slice(range[0], range[1]), 'the Pricing\nsection');
    assert.strictEqual(findExcerptRange(text, 'not there'), null);
  });

  it('matches excerpts ignoring whitespace and case only', () => {
    assert.strictEqual(isVerbatimExcerpt('THE  pricing\nsection', 'the pricing section went'), true);
    assert.strictEqual(isVerbatimExcerpt('the prices section', 'the pricing section went'), false);
  });
});

describe('synthetic seed data', () => {
  it('pairs the same-event entries and not the same-tag-different-event one', () => {
    const now = T0 + 20 * DAY;
    const seeded = createSyntheticEntries(now);
    const lastWeek = seeded.filter((e) => e.createdAt >= now - 7 * DAY);
    const pairs = findCandidatePairs(lastWeek);
    const texts = pairs.map((p) => `${p.a.correctedTranscript} || ${p.b.correctedTranscript}`);
    assert.ok(texts.some((t) => t.includes('preparing slides') && t.includes('demo happened')));
    assert.ok(texts.some((t) => t.includes('tabiyat kharab') && t.includes('doctor ke paas')));
    assert.ok(!texts.some((t) => t.includes('appraisal')));
    assert.ok(seeded.every((e) => e.correctedTranscript.startsWith('[SYNTHETIC]')));
    assert.ok(seeded.every((e) => e.metrics.sttMs === 0 && e.tagStatus === 'none'));
  });
});
