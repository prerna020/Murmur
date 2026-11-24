import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentStems, snippetAround, stem } from '../src/services/report/terms.ts';
import { findTopicCandidates } from '../src/services/report/candidates.ts';
import { prescriptivePhrase, questionProblem } from '../src/services/report/checks.ts';
import {
  MAX_MODEL_CALLS,
  buildCodeOnlyReport,
  generateWeeklyReport,
  revalidateReport,
} from '../src/services/report/weeklyReport.ts';
import type { JournalEntry } from '../src/types/journal';
import type { LlmCallResult, LlmCallStats } from '../src/services/tagSuggestion.ts';

const DAY = 24 * 60 * 60 * 1000;
const MON = new Date(2026, 10, 16, 20).getTime(); // local Monday evening

function entry(id: string, dayOffset: number, text: string, tags: string[] = []): JournalEntry {
  return {
    id,
    createdAt: MON + dayOffset * DAY,
    updatedAt: MON + dayOffset * DAY,
    rawTranscript: text,
    sttEngine: null,
    correctedTranscript: text,
    moodSelection: null,
    tags,
    tagStatus: 'none',
    metrics: { audioLengthMs: 0, sttMs: 0, llmMs: 0, retryCount: 0 },
  };
}

const mon = entry(
  'mon',
  0,
  "I don't think I'm prepared for my interview on Saturday, especially explaining my project.",
  ['work_study']
);
const wed = entry('wed', 2, 'Interview practice today. I struggled to explain my project clearly.', ['work_study']);
const fri = entry('fri', 4, 'Finally managed to explain my project properly in the mock interview.', ['work_study']);
const mummy = entry('mummy', 1, 'Mummy ki tabiyat theek nahi thi, doctor ke paas gaye.', ['family']);
const movie = entry('movie', 3, 'Watched a movie with friends at the mall, lots of popcorn.', ['leisure']);
const week = [mon, wed, fri, mummy, movie];

describe('report terms', () => {
  it('folds word forms for grouping', () => {
    assert.strictEqual(stem('preparing'), stem('prepared'));
    assert.strictEqual(stem('interviews'), 'interview');
    assert.strictEqual(stem('explaining'), 'explain');
    assert.strictEqual(stem('class'), 'class');
  });

  it('drops stop words, short words and Hinglish fillers', () => {
    const s = contentStems('Aaj bahut kaam tha but the interview went fine');
    assert.ok(s.has('interview'));
    assert.ok(!s.has('bahut') && !s.has('the') && !s.has('aaj'));
  });

  it('cuts snippets that are exact substrings of the text', () => {
    const snip = snippetAround(mon.correctedTranscript, ['project'], 4);
    assert.ok(snip && mon.correctedTranscript.includes(snip));
    assert.ok(snip?.includes('project'));
    assert.strictEqual(snippetAround('nothing relevant here', ['project']), null);
  });
});

describe('topic candidates', () => {
  const topics = findTopicCandidates(week, week, []);

  it('groups the three interview entries into one recurring topic, in time order', () => {
    assert.ok(topics.length >= 1);
    const t = topics[0];
    assert.deepStrictEqual(
      t.refs.map((r) => r.entry.id),
      ['mon', 'wed', 'fri']
    );
    assert.strictEqual(t.dayCount, 3);
    assert.ok(t.words.includes('interview'));
    for (const r of t.refs) assert.ok(r.entry.correctedTranscript.includes(r.snippet));
  });

  it('leaves unrelated entries out', () => {
    const ids = topics.flatMap((t) => t.refs.map((r) => r.entry.id));
    assert.ok(!ids.includes('mummy') && !ids.includes('movie'));
  });

  it('does not make a topic out of one shared word between two entries', () => {
    const a = entry('a', 0, 'Dropped my phone on the stairs this afternoon.');
    const b = entry('b', 1, 'Called my sister on the phone for an hour.');
    const c = entry('c', 2, 'Cooked rajma chawal for dinner.');
    assert.deepStrictEqual(findTopicCandidates([a, b, c], [a, b, c], []), []);
  });

  it('counts mentions in the previous week', () => {
    const lastWeek = entry('lw', -5, 'First call about the interview with the recruiter.');
    const t = findTopicCandidates(week, [...week, lastWeek], [lastWeek])[0];
    assert.strictEqual(t.previousWeekEntries, 1);
  });

  it('flags a latest mention that still sounds unsettled', () => {
    const later = entry('sat', 5, "Interview tomorrow, still not sure how to explain my project.", ['work_study']);
    const t = findTopicCandidates([...week, later], [...week, later], [])[0];
    assert.strictEqual(t.latestSoundsUnsettled, true);
  });
});

describe('reply checks', () => {
  it('rejects advice, praise and pep talk', () => {
    assert.ok(prescriptivePhrase('You should practise more.'));
    assert.ok(prescriptivePhrase('Great job on the interview!'));
    assert.ok(prescriptivePhrase('Keep it up, you got this'));
    assert.strictEqual(prescriptivePhrase('Your Friday entry describes explaining the project properly.'), null);
  });

  it('accepts only open questions', () => {
    assert.strictEqual(questionProblem('What made Friday’s explanation work?', 20), null);
    assert.ok(questionProblem('You could try practising more.', 20));
    assert.ok(questionProblem('Should you practise more?', 20));
    assert.ok(questionProblem('What should you change before Saturday?', 20));
  });
});

// ---- orchestration with a fake model, routed by prompt type
const stats: LlmCallStats = {
  firstTokenMs: 1, totalMs: 1, tokensGenerated: 1, promptTokens: 1, prefillMs: 1, decodeMs: 1,
  finishReason: 'stop', rawChars: 1, answerChars: 1, hadThinkBlock: false, modelLoaded: true,
  modelSessionId: 1, callIndexInSession: 1,
};

type Route = 'topic' | 'change' | 'question' | 'connection';
function route(prompt: string): Route {
  if (prompt.startsWith('Short parts')) return 'topic';
  if (prompt.startsWith('Two parts')) return 'change';
  if (prompt.includes('came up in several')) return 'question';
  return 'connection';
}

function fakeModel(replies: Partial<Record<Route, string[]>>) {
  const calls: { route: Route; prompt: string }[] = [];
  const call = async (prompt: string): Promise<LlmCallResult> => {
    const r = route(prompt);
    calls.push({ route: r, prompt });
    const next = replies[r]?.shift();
    if (next === undefined) return { text: r === 'connection' ? '{"supported": false}' : '{"topic": null}', stats };
    return { text: next, stats };
  };
  return { call, calls };
}

const goodTopic = JSON.stringify({
  topic: 'Interview preparation',
  why: 'Three entries describe getting ready to explain your project in an interview.',
  evidence: [
    { entry: 'A', quote: "I don't think I'm prepared for my interview" },
    { entry: 'C', quote: 'explain my project properly' },
  ],
});
const goodChange = JSON.stringify({
  changed: true,
  observation: 'On Monday you doubted you were prepared; on Friday you wrote that you explained your project properly.',
  earlier: "I don't think I'm prepared",
  later: 'managed to explain my project properly',
});
const goodQuestion = JSON.stringify({
  question: 'What was different on Friday when the explanation worked?',
  entry: 'C',
  quote: 'Finally managed to explain my project',
});

describe('generateWeeklyReport', () => {
  const input = { weekEntries: week, allEntries: week, previousWeekEntries: [] };

  it('produces a named topic, a change and a question, all quoting real entries', async () => {
    const model = fakeModel({ topic: [goodTopic], change: [goodChange], question: [goodQuestion] });
    const report = await generateWeeklyReport(input, model.call);
    assert.strictEqual(report.topics[0].label, 'Interview preparation');
    assert.strictEqual(report.topics[0].entryCount, 3);
    assert.strictEqual(report.changes.length, 1);
    assert.strictEqual(report.changes[0].earlier.entryId, 'mon');
    assert.strictEqual(report.changes[0].later.entryId, 'fri');
    assert.strictEqual(report.changes[0].inBetween, 1);
    assert.strictEqual(report.questions.length, 1);
    assert.strictEqual(report.questions[0].basedOn.entryId, 'fri');
    assert.ok(report.metrics.modelCalls <= MAX_MODEL_CALLS);
    assert.strictEqual(report.metrics.verified, 3);
  });

  it('sends only snippets of the entries involved, never ids or other entries', async () => {
    const model = fakeModel({ topic: [goodTopic] });
    await generateWeeklyReport(input, model.call);
    for (const c of model.calls.filter((x) => x.route !== 'connection')) {
      assert.ok(!c.prompt.includes('mummy') && !c.prompt.includes('popcorn'));
      assert.ok(!c.prompt.includes('"mon"') && !c.prompt.includes('fri@'));
    }
  });

  it('keeps the code-found topic when the model names nothing', async () => {
    const report = await generateWeeklyReport(input, fakeModel({}).call);
    assert.strictEqual(report.topics.length >= 1, true);
    assert.strictEqual(report.topics[0].label, null);
    assert.ok(report.topics[0].quotes.every((q) => week.find((e) => e.id === q.entryId)!.correctedTranscript.includes(q.quote)));
    assert.strictEqual(report.changes.length, 0);
  });

  it('accepts "no change" as an answer and does not invent progress', async () => {
    const report = await generateWeeklyReport(input, fakeModel({ change: ['{"changed": false}'] }).call);
    assert.strictEqual(report.changes.length, 0);
    assert.ok(report.metrics.declined >= 1);
  });

  it('rejects an invented quote, retries once with the exact problem, then drops it', async () => {
    const invented = JSON.stringify({
      changed: true,
      observation: 'You felt much more confident by Friday.',
      earlier: 'I was terrified of the interview',
      later: 'managed to explain my project properly',
    });
    const model = fakeModel({ change: [invented, invented] });
    const report = await generateWeeklyReport(input, model.call);
    assert.strictEqual(report.changes.length, 0);
    const changeCalls = model.calls.filter((c) => c.route === 'change');
    assert.strictEqual(changeCalls.length, 2);
    assert.match(changeCalls[1].prompt, /Your last reply was rejected: the EARLIER quote is not an exact copy/);
    assert.ok(report.metrics.quoteFailures >= 2);
  });

  it('rejects motivational wording and advice-style questions', async () => {
    const pep = JSON.stringify({
      changed: true,
      observation: 'Great job, you clearly grew this week!',
      earlier: "I don't think I'm prepared",
      later: 'managed to explain my project properly',
    });
    const advice = JSON.stringify({ question: 'Should you practise every day?', entry: 'C', quote: 'explain my project properly' });
    const report = await generateWeeklyReport(
      input,
      fakeModel({ change: [pep, pep], question: [advice, advice] }).call
    );
    assert.strictEqual(report.changes.length, 0);
    assert.strictEqual(report.questions.length, 0);
  });

  it('makes no model calls with fewer than 3 entries', async () => {
    const model = fakeModel({ topic: [goodTopic] });
    const report = await generateWeeklyReport(
      { weekEntries: [mon, wed], allEntries: [mon, wed], previousWeekEntries: [] },
      model.call
    );
    assert.strictEqual(model.calls.length, 0);
    assert.strictEqual(report.topics.length, 0);
  });

  it('never exceeds the call budget even when every reply is invalid', async () => {
    const many = Array.from({ length: 40 }, () => 'not json');
    const model = fakeModel({ topic: [...many], change: [...many], question: [...many], connection: [...many] });
    const report = await generateWeeklyReport(input, model.call);
    assert.ok(model.calls.length <= MAX_MODEL_CALLS);
    assert.ok(report.topics.length >= 1, 'code-found topic still shown');
  });
});

describe('revalidateReport', () => {
  it('drops items whose quote an edit removed', async () => {
    const report = await generateWeeklyReport(
      { weekEntries: week, allEntries: week, previousWeekEntries: [] },
      fakeModel({ topic: [goodTopic], change: [goodChange], question: [goodQuestion] }).call
    );
    const editedFri = { ...fri, correctedTranscript: 'Mock interview got cancelled.', updatedAt: fri.updatedAt + 1 };
    const { report: cleaned, dropped } = revalidateReport(report, [mon, wed, editedFri, mummy, movie]);
    assert.strictEqual(cleaned.changes.length, 0);
    assert.strictEqual(cleaned.questions.length, 0);
    assert.ok(dropped >= 2);
  });

  it('code-only report needs 3 entries', () => {
    assert.strictEqual(buildCodeOnlyReport({ weekEntries: [mon], allEntries: [mon], previousWeekEntries: [] }).report.topics.length, 0);
  });
});

describe('synthetic seed for the report', () => {
  it('yields the interview story as a recurring topic across 3 days', async () => {
    const { createSyntheticEntries } = await import('../src/services/syntheticEntries.ts');
    const now = MON + 20 * DAY;
    const seeded = createSyntheticEntries(now);
    const lastWeek = seeded.filter((e) => e.createdAt >= now - 7 * DAY);
    const topics = findTopicCandidates(lastWeek, seeded, []);
    const interview = topics.find((t) => t.words.includes('interview'));
    assert.ok(interview, `topics: ${topics.map((t) => t.words.join('/')).join('; ')}`);
    assert.strictEqual(interview.refs.length, 3);
    assert.strictEqual(interview.dayCount, 3);
  });
});
