import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jaccard, mean, microPrecisionRecall, pct, percentile } from '../benchmark/metrics.ts';

describe('benchmark metrics', () => {
  it('nearest-rank percentiles', () => {
    const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    assert.strictEqual(percentile(v, 50), 500);
    assert.strictEqual(percentile(v, 95), 1000);
    assert.strictEqual(percentile([42], 95), 42);
    assert.strictEqual(percentile([], 50), null);
  });

  it('jaccard with case-insensitive tags', () => {
    assert.strictEqual(jaccard(['Health', 'family'], ['family', 'health']), 1);
    assert.strictEqual(jaccard(['health'], ['family']), 0);
    assert.strictEqual(jaccard(['health', 'money'], ['health']), 0.5);
    assert.strictEqual(jaccard([], []), 1);
  });

  it('micro precision and recall', () => {
    const r = microPrecisionRecall([
      { predicted: ['work_study', 'goals'], truth: ['work_study'] },
      { predicted: [], truth: ['health'] },
    ]);
    assert.strictEqual(r.precision, 0.5);
    assert.strictEqual(r.recall, 0.5);
    assert.strictEqual(microPrecisionRecall([]).precision, null);
  });

  it('renders missing values as "not measured"', () => {
    assert.strictEqual(pct(null), 'not measured');
    assert.strictEqual(mean([]), null);
  });
});
