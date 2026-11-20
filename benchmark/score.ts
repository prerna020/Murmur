import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DatasetItem {
  id: string;
  text: string;
  language: 'en' | 'hinglish';
  mood: string;
  topics: string[];
}

export interface EntryResult {
  id: string;
  language: 'en' | 'hinglish';
  groundTruth: {
    mood: string;
    topics: string[];
  };
  pipelineResult: {
    predictedMood: string;
    predictedTopics: string[];
    summary: string;
    path: 'llm' | 'llm_retry' | 'fallback';
    llmLatencyMs: number;
    retryCount: number;
    firstAttemptValid: boolean;
  };
  fallbackBaseline?: {
    predictedMood: string;
    predictedTopics: string[];
    summary: string;
  };
}

export interface ResultsPayload {
  timestamp: string;
  modelName: string;
  modelId?: string;
  languageConfig?: string;
  device?: {
    brand: string;
    model: string;
    androidVersion: string;
    platform: string;
  };
  totalEntries: number;
  completedEntries: number;
  cancelled?: boolean;
  results: EntryResult[];
}

export interface SttEntryResult {
  id: string;
  fileName: string;
  language: 'en' | 'hinglish';
  referenceTranscript: string;
  hypothesisTranscript: string | null;
  status: 'completed' | 'not_measured' | 'error';
  wer: number | null;
  transcriptionTimeMs: number | null;
}

export interface SttPayload {
  timestamp: string;
  modelName: string;
  languageSetting: string;
  totalClips: number;
  measuredClips: number;
  averageWer: number | null;
  averageTranscriptionTimeMs: number | null;
  results: SttEntryResult[];
}

export interface MetricSummary {
  total: number;
  firstAttemptValidPct: string;
  retryPct: string;
  fallbackPct: string;
  moodAccuracyPct: string;
  topicJaccardScore: string;
  latencyP50Ms: string;
  latencyP95Ms: string;
  fallbackMoodAccuracyPct: string;
  fallbackTopicJaccardScore: string;
}

/**
 * Computes Jaccard similarity index between predicted topics and ground truth topics:
 * Jaccard = |Intersection| / |Union|
 */
export function computeJaccard(pred: string[], truth: string[]): number {
  if (pred.length === 0 && truth.length === 0) return 1.0;
  const setA = new Set(pred);
  const setB = new Set(truth);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1.0 : intersection / union;
}

/**
 * Computes percentile from an array of numbers.
 */
export function computePercentile(numbers: number[], p: number): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[index];
}

/**
 * Calculates comprehensive metrics for a given subset of benchmark entries.
 */
export function evaluateEntries(entries: EntryResult[]): MetricSummary {
  if (entries.length === 0) {
    return {
      total: 0,
      firstAttemptValidPct: 'not measured',
      retryPct: 'not measured',
      fallbackPct: 'not measured',
      moodAccuracyPct: 'not measured',
      topicJaccardScore: 'not measured',
      latencyP50Ms: 'not measured',
      latencyP95Ms: 'not measured',
      fallbackMoodAccuracyPct: 'not measured',
      fallbackTopicJaccardScore: 'not measured',
    };
  }

  const total = entries.length;
  const firstAttemptValidCount = entries.filter((e) => e.pipelineResult.firstAttemptValid).length;
  const retryCount = entries.filter((e) => e.pipelineResult.path === 'llm_retry').length;
  const fallbackCount = entries.filter((e) => e.pipelineResult.path === 'fallback').length;

  const moodCorrect = entries.filter((e) => e.pipelineResult.predictedMood === e.groundTruth.mood).length;

  const jaccardScores = entries.map((e) =>
    computeJaccard(e.pipelineResult.predictedTopics, e.groundTruth.topics)
  );
  const avgJaccard = jaccardScores.reduce((sum, score) => sum + score, 0) / total;

  const latencies = entries
    .map((e) => e.pipelineResult.llmLatencyMs)
    .filter((l) => typeof l === 'number' && l >= 0);

  const p50 = computePercentile(latencies, 50);
  const p95 = computePercentile(latencies, 95);

  // Fallback Baseline Metrics
  let fbMoodPct = 'not measured';
  let fbTopicScore = 'not measured';
  const hasFallbackData = entries.every((e) => e.fallbackBaseline);
  if (hasFallbackData) {
    const fbMoodCorrect = entries.filter(
      (e) => e.fallbackBaseline?.predictedMood === e.groundTruth.mood
    ).length;
    fbMoodPct = `${((fbMoodCorrect / total) * 100).toFixed(1)}%`;

    const fbJaccards = entries.map((e) =>
      computeJaccard(e.fallbackBaseline?.predictedTopics ?? [], e.groundTruth.topics)
    );
    const avgFbJaccard = fbJaccards.reduce((sum, s) => sum + s, 0) / total;
    fbTopicScore = `${(avgFbJaccard * 100).toFixed(1)}%`;
  }

  return {
    total,
    firstAttemptValidPct: `${((firstAttemptValidCount / total) * 100).toFixed(1)}%`,
    retryPct: `${((retryCount / total) * 100).toFixed(1)}%`,
    fallbackPct: `${((fallbackCount / total) * 100).toFixed(1)}%`,
    moodAccuracyPct: `${((moodCorrect / total) * 100).toFixed(1)}%`,
    topicJaccardScore: `${(avgJaccard * 100).toFixed(1)}%`,
    latencyP50Ms: `${Math.round(p50)} ms`,
    latencyP95Ms: `${Math.round(p95)} ms`,
    fallbackMoodAccuracyPct: fbMoodPct,
    fallbackTopicJaccardScore: fbTopicScore,
  };
}

const MOOD_LEXICON: Record<string, string[]> = {
  happy: ['happy', 'great', 'awesome', 'good', 'joy', 'excited', 'love', 'amazing', 'thrilled', 'delighted', 'glad', 'proud', 'blessed', 'celebrate', 'fun', 'khush', 'accha', 'achha', 'badhiya', 'mast', 'maza', 'sundar', 'positive'],
  calm: ['calm', 'peaceful', 'relaxed', 'quiet', 'serene', 'chill', 'content', 'restful', 'tranquil', 'relieved', 'sukoon', 'shanti', 'shant', 'aaram'],
  stressed: ['stressed', 'stress', 'overwhelmed', 'busy', 'exhausted', 'hectic', 'pressure', 'tired', 'anxious', 'anxiety', 'rush', 'tense', 'worried', 'headache', 'tension', 'pareshan', 'thak', 'bhagdaud', 'bheed', 'deadline'],
  sad: ['sad', 'lonely', 'depressed', 'down', 'cried', 'crying', 'miss', 'hurt', 'grief', 'heartbroken', 'upset', 'dukhi', 'udaas', 'rona', 'dard', 'akela'],
  angry: ['angry', 'mad', 'annoyed', 'frustrated', 'pissed', 'furious', 'irritated', 'anger', 'hate', 'gussa', 'chidh', 'bakwaas'],
  neutral: ['ok', 'fine', 'normal', 'regular', 'routine', 'usual'],
};

const TOPIC_LEXICON: Record<string, string[]> = {
  work_study: ['work', 'job', 'office', 'meeting', 'project', 'study', 'exam', 'code', 'client', 'task', 'colleague', 'boss', 'school', 'college', 'class', 'career', 'interview', 'presentation', 'kam', 'kaam', 'naukri', 'padhai'],
  relationships: ['friend', 'friends', 'boyfriend', 'girlfriend', 'date', 'partner', 'breakup', 'love', 'conversation', 'talked', 'dost', 'yaari', 'pyaar'],
  family: ['mom', 'dad', 'mother', 'father', 'brother', 'sister', 'parents', 'child', 'kids', 'son', 'daughter', 'family', 'ghar', 'maa', 'papa', 'bhai', 'behen'],
  health: ['gym', 'workout', 'sleep', 'doctor', 'medicine', 'run', 'sick', 'pain', 'food', 'diet', 'walk', 'hospital', 'fever', 'sehat', 'bimari', 'khana'],
  money: ['money', 'expense', 'buy', 'salary', 'budget', 'cost', 'price', 'bank', 'kharcha', 'paisa', 'paise'],
  goals: ['goal', 'goals', 'plan', 'future', 'focus', 'discipline', 'target', 'habit', 'aim', 'sapna'],
  leisure: ['movie', 'game', 'music', 'book', 'read', 'walk', 'cook', 'trip', 'travel', 'ghoomna', 'chilling'],
  other: [],
};

export function runFallbackExtraction(text: string): { mood: string; topics: string[] } {
  const lower = text.toLowerCase();
  const words = new Set(lower.split(/\W+/).filter(Boolean));

  let detectedMood = 'neutral';
  let bestMoodScore = 0;
  for (const [mood, keywords] of Object.entries(MOOD_LEXICON)) {
    let score = 0;
    for (const kw of keywords) {
      if (words.has(kw) || lower.includes(kw)) score++;
    }
    if (score > bestMoodScore) {
      bestMoodScore = score;
      detectedMood = mood;
    }
  }

  const topicScores: Array<{ topic: string; score: number }> = [];
  for (const [topic, keywords] of Object.entries(TOPIC_LEXICON)) {
    if (topic === 'other') continue;
    let score = 0;
    for (const kw of keywords) {
      if (words.has(kw) || lower.includes(kw)) score++;
    }
    if (score > 0) topicScores.push({ topic, score });
  }
  topicScores.sort((a, b) => b.score - a.score);
  let detectedTopics = topicScores.slice(0, 3).map((item) => item.topic);
  if (detectedTopics.length === 0) detectedTopics = ['other'];

  return { mood: detectedMood, topics: detectedTopics };
}

export function evaluateDatasetWithFallback(items: DatasetItem[]) {
  const total = items.length;
  if (total === 0) return { moodAccuracy: '0.0%', topicScore: '0.0%' };

  let moodMatches = 0;
  let totalJaccard = 0;

  for (const item of items) {
    const extracted = runFallbackExtraction(item.text);
    if (extracted.mood === item.mood) moodMatches++;
    totalJaccard += computeJaccard(extracted.topics, item.topics);
  }

  return {
    moodAccuracy: `${((moodMatches / total) * 100).toFixed(1)}%`,
    topicScore: `${((totalJaccard / total) * 100).toFixed(1)}%`,
  };
}
export function main() {
  const benchmarkDir = path.resolve(__dirname);
  const datasetPath = path.join(benchmarkDir, 'dataset.json');

  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found at ${datasetPath}`);
    process.exit(1);
  }

  const dataset: DatasetItem[] = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  // 1. Locate On-Device Results File
  const customArg = process.argv[2];
  const candidateFiles = [
    customArg,
    path.join(benchmarkDir, 'results_device.json'),
    path.join(benchmarkDir, 'benchmark_results.json'),
  ].filter(Boolean) as string[];

  let deviceResultsFile: string | null = null;
  for (const candidate of candidateFiles) {
    if (fs.existsSync(candidate)) {
      deviceResultsFile = candidate;
      break;
    }
  }

  let devicePayload: ResultsPayload | null = null;
  if (deviceResultsFile) {
    try {
      devicePayload = JSON.parse(fs.readFileSync(deviceResultsFile, 'utf8'));
      console.log(`Loaded on-device results from: ${deviceResultsFile}`);
    } catch (e: unknown) {
      console.warn(`Could not parse ${deviceResultsFile}: ${e}`);
    }
  }

  // 2. Locate Cloud Baseline (Gemini) Results File
  const geminiBaselinePath = path.join(benchmarkDir, 'gemini_baseline.json');
  let geminiPayload: ResultsPayload | null = null;
  if (fs.existsSync(geminiBaselinePath)) {
    try {
      geminiPayload = JSON.parse(fs.readFileSync(geminiBaselinePath, 'utf8'));
      console.log(`Loaded Gemini cloud baseline from: ${geminiBaselinePath}`);
    } catch (e: unknown) {
      console.warn(`Could not parse ${geminiBaselinePath}: ${e}`);
    }
  }

  // 3. Locate STT Results File
  const candidateSttFiles = [
    path.join(benchmarkDir, 'stt_results_device.json'),
    path.join(benchmarkDir, 'stt_benchmark_results.json'),
  ];
  let sttPayload: SttPayload | null = null;
  for (const f of candidateSttFiles) {
    if (fs.existsSync(f)) {
      try {
        sttPayload = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log(`Loaded STT benchmark results from: ${f}`);
        break;
      } catch (e: unknown) {
        console.warn(`Could not parse ${f}: ${e}`);
      }
    }
  }

  // Evaluate Fallback Baseline on Ground Truth Dataset
  const fallbackOverall = evaluateDatasetWithFallback(dataset);

  // Evaluate On-Device Results
  const deviceEntries = devicePayload?.results ?? [];
  const deviceOverall = evaluateEntries(deviceEntries);
  const deviceEn = evaluateEntries(deviceEntries.filter((e) => e.language === 'en'));
  const deviceHi = evaluateEntries(deviceEntries.filter((e) => e.language === 'hinglish'));

  // Evaluate Gemini Cloud Baseline
  const geminiEntries = geminiPayload?.results ?? [];
  const geminiOverall = evaluateEntries(geminiEntries);
  const geminiEn = evaluateEntries(geminiEntries.filter((e) => e.language === 'en'));
  const geminiHi = evaluateEntries(geminiEntries.filter((e) => e.language === 'hinglish'));

  // Evaluate STT Results
  let sttOverallWer = 'not measured';
  let sttOverallTime = 'not measured';
  let sttEnWer = 'not measured';
  let sttEnTime = 'not measured';
  let sttHiWer = 'not measured';
  let sttHiTime = 'not measured';

  if (sttPayload && sttPayload.results && sttPayload.results.length > 0) {
    const measuredClips = sttPayload.results.filter(
      (c) => c.status === 'completed' && c.wer !== null
    );
    if (measuredClips.length > 0) {
      const avgWer =
        measuredClips.reduce((acc, c) => acc + (c.wer ?? 0), 0) / measuredClips.length;
      sttOverallWer = `${(avgWer * 100).toFixed(1)}%`;

      const avgTime =
        measuredClips.reduce((acc, c) => acc + (c.transcriptionTimeMs ?? 0), 0) /
        measuredClips.length;
      sttOverallTime = `${Math.round(avgTime)} ms`;

      // Split by language
      const enClips = measuredClips.filter((c) => c.language === 'en');
      if (enClips.length > 0) {
        const enWer = enClips.reduce((acc, c) => acc + (c.wer ?? 0), 0) / enClips.length;
        sttEnWer = `${(enWer * 100).toFixed(1)}%`;
        const enTime =
          enClips.reduce((acc, c) => acc + (c.transcriptionTimeMs ?? 0), 0) / enClips.length;
        sttEnTime = `${Math.round(enTime)} ms`;
      }

      const hiClips = measuredClips.filter((c) => c.language === 'hinglish');
      if (hiClips.length > 0) {
        const hiWer = hiClips.reduce((acc, c) => acc + (c.wer ?? 0), 0) / hiClips.length;
        sttHiWer = `${(hiWer * 100).toFixed(1)}%`;
        const hiTime =
          hiClips.reduce((acc, c) => acc + (c.transcriptionTimeMs ?? 0), 0) / hiClips.length;
        sttHiTime = `${Math.round(hiTime)} ms`;
      }
    } else {
      sttOverallWer = 'not measured (audio clips not recorded yet)';
      sttOverallTime = 'not measured (audio clips not recorded yet)';
    }
  }

  // Device model string
  const deviceModelStr = devicePayload?.device
    ? `${devicePayload.device.brand} ${devicePayload.device.model} (Android ${devicePayload.device.androidVersion})`
    : 'Android Physical Phone';

  // Generate Markdown Document
  const markdown = `# Murmur Benchmark Results

Generated on: ${new Date().toISOString()}  
Device Target: ${deviceModelStr}  
Dataset: 50 Synthetic Entries (25 English, 25 Hinglish in Latin Script)

---

## 1. Structured Extraction Performance (LLM vs Rule-Based Fallback vs Cloud)

*Topic score is measured using the Jaccard similarity coefficient: $|\\text{predicted} \\cap \\text{truth}| / |\\text{predicted} \\cup \\text{truth}|$.*

| Metric | On-Device Overall (Qwen 3 0.6B) | On-Device English (25) | On-Device Hinglish (25) | Rule-Based Fallback Baseline | Cloud Baseline (Gemini Flash) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Total Evaluated** | ${deviceOverall.total > 0 ? deviceOverall.total : 'not measured'} | ${deviceEn.total > 0 ? deviceEn.total : 'not measured'} | ${deviceHi.total > 0 ? deviceHi.total : 'not measured'} | ${dataset.length} | ${geminiOverall.total > 0 ? geminiOverall.total : 'not measured'} |
| **Valid Output (1st Attempt)** | ${deviceOverall.firstAttemptValidPct} | ${deviceEn.firstAttemptValidPct} | ${deviceHi.firstAttemptValidPct} | N/A (Rule) | ${geminiOverall.firstAttemptValidPct} |
| **Valid Output (After Retry)** | ${deviceOverall.retryPct} | ${deviceEn.retryPct} | ${deviceHi.retryPct} | N/A (Rule) | ${geminiOverall.retryPct} |
| **Fallback Used** | ${deviceOverall.fallbackPct} | ${deviceEn.fallbackPct} | ${deviceHi.fallbackPct} | 100.0% | ${geminiOverall.fallbackPct} |
| **Mood Accuracy** | ${deviceOverall.moodAccuracyPct} | ${deviceEn.moodAccuracyPct} | ${deviceHi.moodAccuracyPct} | ${deviceOverall.total > 0 ? deviceOverall.fallbackMoodAccuracyPct : fallbackOverall.moodAccuracy} | ${geminiOverall.moodAccuracyPct} |
| **Topic Score (Jaccard Overlap)** | ${deviceOverall.topicJaccardScore} | ${deviceEn.topicJaccardScore} | ${deviceHi.topicJaccardScore} | ${deviceOverall.total > 0 ? deviceOverall.fallbackTopicJaccardScore : fallbackOverall.topicScore} | ${geminiOverall.topicJaccardScore} |
| **LLM Latency p50** | ${deviceOverall.latencyP50Ms} | ${deviceEn.latencyP50Ms} | ${deviceHi.latencyP50Ms} | < 1 ms | ${geminiOverall.latencyP50Ms} |
| **LLM Latency p95** | ${deviceOverall.latencyP95Ms} | ${deviceEn.latencyP95Ms} | ${deviceHi.latencyP95Ms} | < 1 ms | ${geminiOverall.latencyP95Ms} |

---

## 2. Speech-to-Text Performance (Whisper Small On-Device)

*Evaluated on 10 standardized reference clips (5 English, 5 Hinglish).*

| STT Metric | Overall (10 Clips) | English Clips (5) | Hinglish Clips (5) |
| :--- | :---: | :---: | :---: |
| **Average Word Error Rate (WER)** | ${sttOverallWer} | ${sttEnWer} | ${sttHiWer} |
| **Average Transcription Time** | ${sttOverallTime} | ${sttEnTime} | ${sttHiTime} |

---

## 3. How I Measured This

### Dataset Composition
- **Synthetic Design**: The dataset consists of 50 fully synthetic journal entries (25 English, 25 Hinglish in Latin script) constructed specifically for mobile voice journaling evaluation.
- **Privacy Assurance**: Zero real personal data or user journal entries were used. All names, events, and scenarios were fabricated for reproducible testing.
- **Challenging Test Cases**: The test suite includes intentional edge cases:
  - Mixed emotional states (e.g. feeling relieved yet overwhelmed after a stressful deadline).
  - Very short utterances (single-sentence thoughts).
  - Long rambling transcripts approaching the model's token context window.
  - Sarcastic expressions (e.g. *"Oh fantastic, another emergency meeting"*).
  - Entries fitting the \`other\` topic catch-all.

### Ground-Truth Labeling & Arguable Labels
- Draft labels were established strictly adhering to the 6 fixed moods (\`happy\`, \`calm\`, \`neutral\`, \`stressed\`, \`sad\`, \`angry\`) and 8 fixed topics (\`work_study\`, \`relationships\`, \`family\`, \`health\`, \`money\`, \`goals\`, \`leisure\`, \`other\`).
- 22 boundary entries where subjective human interpretation could reasonably assign alternative moods or secondary topics were cataloged in Phase 3A to establish fair evaluation bounds.

### Execution Methodology
- **On-Device Run**: Executed directly on physical Android hardware using \`react-native-executorch\` without dev server assistance. Both inference (Qwen 3 0.6B) and transcription (Whisper Small) run in CPU/XNNPACK mode.
- **3-Tier Reliability Pipeline**: Every entry tests Tier 1 (Initial LLM generation + Zod schema validation), Tier 2 (single self-correction retry appending exact validation errors), and Tier 3 (deterministic keyword/lexicon fallback).
- **Cloud Baseline**: Run on laptop via \`benchmark/gemini_baseline.ts\` calling the Gemini API with the exact same system prompt, schema constraints, and temperature (0.1) to establish an upper-bound reference. The mobile app itself contains zero cloud SDKs or network telemetry.

### Benchmark Limitations
- **Synthetic vs Spontaneous Speech**: Synthesized text transcripts cannot model real-world acoustic disfluencies, pauses, stuttering, or ambient background noise.
- **Hinglish Tokenization**: Latin-script Hindi words (e.g., *"bhagdaud"*, *"sukoon"*) consume more subword tokens than standard English text, creating higher latency on on-device LLMs with smaller context budgets.
- **Single Turn Extraction**: The benchmark evaluates isolated journal entries without multi-turn conversational history.
`;

  const outputPath = path.join(benchmarkDir, 'results.md');
  fs.writeFileSync(outputPath, markdown, 'utf8');

  console.log(`\n========================================`);
  console.log(`Results scored successfully!`);
  console.log(`Markdown report saved to: ${outputPath}`);
  console.log(`========================================\n`);
  console.log(markdown);
}

main();
