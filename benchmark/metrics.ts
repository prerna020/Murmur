/**
 * Pure scoring helpers for benchmark/score.ts. No file access, so they can be
 * unit-tested (tests/benchmarkMetrics.test.ts).
 */

/** Nearest-rank percentile (p in 0..100). null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function norm(tags: readonly string[]): Set<string> {
  return new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
}

/** |predicted ∩ truth| / |predicted ∪ truth|. Both empty counts as 1. */
export function jaccard(predicted: readonly string[], truth: readonly string[]): number {
  const p = norm(predicted);
  const t = norm(truth);
  if (p.size === 0 && t.size === 0) return 1;
  const inter = [...p].filter((x) => t.has(x)).length;
  const union = new Set([...p, ...t]).size;
  return inter / union;
}

export interface MicroPR {
  truePositives: number;
  predicted: number;
  actual: number;
  precision: number | null;
  recall: number | null;
}

/** Micro-averaged precision and recall over all clips (each tag counted once per clip). */
export function microPrecisionRecall(
  pairs: readonly { predicted: readonly string[]; truth: readonly string[] }[]
): MicroPR {
  let tp = 0;
  let predicted = 0;
  let actual = 0;
  for (const { predicted: p, truth: t } of pairs) {
    const ps = norm(p);
    const ts = norm(t);
    predicted += ps.size;
    actual += ts.size;
    tp += [...ps].filter((x) => ts.has(x)).length;
  }
  return {
    truePositives: tp,
    predicted,
    actual,
    precision: predicted === 0 ? null : tp / predicted,
    recall: actual === 0 ? null : tp / actual,
  };
}

export function pct(value: number | null, digits = 1): string {
  return value === null ? 'not measured' : `${(value * 100).toFixed(digits)}%`;
}

export function ms(value: number | null): string {
  return value === null ? 'not measured' : `${Math.round(value)} ms`;
}
