import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestTopicTags,
  truncateForTagging,
  TagAttemptTimeoutError,
  MAX_TAG_INPUT_CHARS,
  type LlmCallResult,
  type LlmCallStats,
} from '../src/services/tagSuggestion.ts';

const stats: LlmCallStats = {
  firstTokenMs: 10,
  totalMs: 20,
  tokensGenerated: 5,
  promptTokens: 100,
  prefillMs: 8,
  decodeMs: 12,
  finishReason: 'stop',
  rawChars: 20,
  answerChars: 20,
  hadThinkBlock: false,
  modelLoaded: true,
  modelSessionId: 1,
  callIndexInSession: 1,
};

/** Fake model that returns the given outputs in order; an Error entry makes the call throw. */
function fakeModel(outputs: (string | Error)[]) {
  const prompts: string[] = [];
  const send = async (prompt: string): Promise<LlmCallResult> => {
    prompts.push(prompt);
    const next = outputs.shift();
    if (next === undefined) throw new Error('unexpected extra call');
    if (next instanceof Error) throw next;
    return { text: next, stats };
  };
  return { send, prompts };
}

describe('suggestTopicTags retry rule', () => {
  it('returns ok on a valid first attempt, with one attempt record', async () => {
    const model = fakeModel(['{"tags": ["health"]}']);
    const result = await suggestTopicTags('went to the gym', model.send);
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(result.tags, ['health']);
    assert.strictEqual(result.retryCount, 0);
    assert.strictEqual(result.attempts.length, 1);
    assert.strictEqual(result.attempts[0].outcome, 'valid');
  });

  it('retries once with the schema error, then returns retry_ok', async () => {
    const model = fakeModel(['{"tags": ["sports"]}', '{"tags": ["leisure"]}']);
    const result = await suggestTopicTags('played cricket', model.send);
    assert.strictEqual(result.status, 'retry_ok');
    assert.deepStrictEqual(result.tags, ['leisure']);
    assert.deepStrictEqual(
      result.attempts.map((a) => a.outcome),
      ['schema_error', 'valid']
    );
    assert.ok(model.prompts[1].includes('Your last reply was rejected:'));
    assert.ok(!model.prompts[0].includes('rejected'));
  });

  it('retries once after unparseable output or a thrown call', async () => {
    const parse = fakeModel(['no json here', '{"tags": []}']);
    assert.strictEqual((await suggestTopicTags('x', parse.send)).status, 'retry_ok');
    assert.ok(parse.prompts[1].includes('not a valid JSON object'));

    const thrown = fakeModel([new Error('busy'), '{"tags": ["money"]}']);
    const result = await suggestTopicTags('x', thrown.send);
    assert.strictEqual(result.status, 'retry_ok');
    assert.strictEqual(result.attempts[0].outcome, 'threw');
    assert.strictEqual(result.attempts[0].stats, null);
  });

  it('counts a timeout as the failed attempt and retries once', async () => {
    const model = fakeModel([new TagAttemptTimeoutError(20_000), '{"tags": ["family"]}']);
    const result = await suggestTopicTags('x', model.send);
    assert.strictEqual(result.status, 'retry_ok');
    assert.strictEqual(result.attempts[0].outcome, 'timeout');
    assert.ok(model.prompts[1].includes('took too long'));

    const twice = fakeModel([new TagAttemptTimeoutError(20_000), new TagAttemptTimeoutError(20_000)]);
    const failed = await suggestTopicTags('x', twice.send);
    assert.strictEqual(failed.status, 'failed');
    assert.deepStrictEqual(failed.tags, []);
  });

  it('accepts tag names in other letter case but never invents tags', async () => {
    const ok = await suggestTopicTags('x', fakeModel(['{"tags": [" Health ", "HEALTH"]}']).send);
    assert.deepStrictEqual(ok.tags, ['health']);
    const bad = fakeModel(['{"tags": ["fitness"]}', '{"tags": ["fitness"]}']);
    assert.strictEqual((await suggestTopicTags('x', bad.send)).status, 'failed');
  });

  it('prompt has no example answer with real tag names', async () => {
    const model = fakeModel(['{"tags": ["other"]}']);
    await suggestTopicTags('x', model.send);
    assert.ok(!/\{\s*"tags"\s*:\s*\[\s*"/.test(model.prompts[0]));
  });

  it('fails with no tags after two bad attempts, and never makes a third call', async () => {
    const model = fakeModel(['{"tags": ["a","b","c","d"]}', new Error('timeout')]);
    const result = await suggestTopicTags('x', model.send);
    assert.strictEqual(result.status, 'failed');
    assert.deepStrictEqual(result.tags, []);
    assert.strictEqual(result.retryCount, 1);
    assert.strictEqual(model.prompts.length, 2);
  });
});

describe('truncateForTagging', () => {
  it('keeps short text, collapsing whitespace', () => {
    assert.strictEqual(truncateForTagging('  aaj   office  gaya '), 'aaj office gaya');
  });

  it('cuts long text at a word boundary within the limit', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const out = truncateForTagging(words);
    assert.ok(out.length <= MAX_TAG_INPUT_CHARS);
    assert.ok(words.startsWith(out));
    assert.ok(words.charAt(out.length) === ' ', 'must not split a word');
  });

  it('hard-cuts text with no spaces', () => {
    assert.strictEqual(truncateForTagging('x'.repeat(900)).length, MAX_TAG_INPUT_CHARS);
  });
});
