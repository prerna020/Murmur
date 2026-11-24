/**
 * Word Error Rate (WER) computation using Levenshtein distance on normalized word sequences.
 * Standard metric for Speech-to-Text evaluation:
 *   WER = (Substitutions + Deletions + Insertions) / Total Reference Words
 */

export interface WerResult {
  wer: number; // Ratio (0.0 = 100% accurate, can be > 1.0 if many insertions)
  substitutions: number;
  deletions: number;
  insertions: number;
  refWordsCount: number;
  hypWordsCount: number;
}

/**
 * Normalizes text for speech recognition scoring:
 * - Converts to lowercase
 * - Strips common punctuation
 * - Collapses whitespace into token array
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Computes exact WER and edit breakdown (S, D, I) via Dynamic Programming.
 */
export function computeWordErrorRate(referenceText: string, hypothesisText: string): WerResult {
  const ref = normalizeWords(referenceText);
  const hyp = normalizeWords(hypothesisText);

  const n = ref.length;
  const m = hyp.length;

  if (n === 0 && m === 0) {
    return {
      wer: 0,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      refWordsCount: 0,
      hypWordsCount: 0,
    };
  }

  if (n === 0) {
    return {
      wer: 1.0,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      refWordsCount: 0,
      hypWordsCount: m,
    };
  }

  // DP table: dp[i][j] holds { cost, s, d, ins }
  const dp: { cost: number; s: number; d: number; ins: number }[][] = Array.from(
    { length: n + 1 },
    () => Array.from({ length: m + 1 }, () => ({ cost: 0, s: 0, d: 0, ins: 0 }))
  );

  // Initialize deletions (ref to empty hyp)
  for (let i = 1; i <= n; i++) {
    dp[i][0] = { cost: i, s: 0, d: i, ins: 0 };
  }

  // Initialize insertions (empty ref to hyp)
  for (let j = 1; j <= m; j++) {
    dp[0][j] = { cost: j, s: 0, d: 0, ins: j };
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = ref[i - 1] === hyp[j - 1];

      // Substitution or Match
      const subCost = match ? 0 : 1;
      const subCell = dp[i - 1][j - 1];
      const subCandidate = {
        cost: subCell.cost + subCost,
        s: subCell.s + subCost,
        d: subCell.d,
        ins: subCell.ins,
      };

      // Deletion
      const delCell = dp[i - 1][j];
      const delCandidate = {
        cost: delCell.cost + 1,
        s: delCell.s,
        d: delCell.d + 1,
        ins: delCell.ins,
      };

      // Insertion
      const insCell = dp[i][j - 1];
      const insCandidate = {
        cost: insCell.cost + 1,
        s: insCell.s,
        d: insCell.d,
        ins: insCell.ins + 1,
      };

      // Pick minimum cost candidate
      let best = subCandidate;
      if (delCandidate.cost < best.cost) best = delCandidate;
      if (insCandidate.cost < best.cost) best = insCandidate;

      dp[i][j] = best;
    }
  }

  const finalCell = dp[n][m];
  const wer = Number((finalCell.cost / n).toFixed(4));

  return {
    wer,
    substitutions: finalCell.s,
    deletions: finalCell.d,
    insertions: finalCell.ins,
    refWordsCount: n,
    hypWordsCount: m,
  };
}

