/**
 * Shapes shared by the on-device benchmark runner (writes) and the laptop
 * scoring script benchmark/score.ts (reads). Pure types only.
 */

export type ClipLanguage = 'en' | 'hinglish';

/** One row of benchmark/clips.json. You fill referenceTranscript and tags by hand. */
export interface BenchmarkClip {
  id: string;
  fileName: string;
  language: ClipLanguage;
  targetSeconds: number;
  hardCase: 'short' | 'sarcasm' | 'mixed_emotions' | 'other_topic' | 'multi_topic' | null;
  suggestedTopics: string;
  prompt: string;
  /** Exactly what you said, written by you after listening back. */
  referenceTranscript: string;
  /** Your 1-3 correct topic tags for the clip. */
  tags: string[];
}

export interface TagRunRecord {
  /** Which text was tagged. */
  input: 'raw' | 'corrected';
  inputChars: number;
  tags: string[];
  tagStatus: 'ok' | 'retry_ok' | 'failed' | 'none';
  llmMs: number;
  retryCount: number;
  firstAttemptValid: boolean;
  attemptOutcomes: string[];
}

export interface ClipRunResult {
  id: string;
  language: ClipLanguage;
  sttEngine: string;
  status: 'completed' | 'not_measured' | 'error';
  /** Why a clip was not measured or failed. No transcript text. */
  note: string | null;
  audioMs: number | null;
  sttMs: number | null;
  /** Engine output exactly as returned (Devanagari for the Hindi engine). */
  rawTranscript: string | null;
  /** Raw output after the app's Devanagari-to-Roman conversion (what the review card starts with). */
  rawTranscriptRoman: string | null;
  tagsOnRaw: TagRunRecord | null;
  tagsOnCorrected: TagRunRecord | null;
}

export interface DeviceRunPayload {
  kind: 'murmur-benchmark-device-run';
  version: 1;
  timestamp: string;
  device: { manufacturer: string; model: string; androidVersion: string; apiLevel: number };
  build: 'debug-js' | 'release-js';
  models: {
    englishStt: { engine: string; modelPath: string };
    hinglishStt: { engine: string; recognizer: string };
    llm: string;
  };
  clips: ClipRunResult[];
}

/** Weekly report runs exported from the encrypted cache: counts and metrics only, no text. */
export interface InsightMetricsPayload {
  kind: 'murmur-insight-metrics';
  version: 2;
  timestamp: string;
  weeks: {
    weekKey: string;
    entryCount: number;
    syntheticCount: number;
    /** Items later hidden because an edit broke their quote. */
    droppedAsStale: number;
    shown: { topics: number; namedTopics: number; changes: number; connections: number; questions: number };
    metrics: {
      modelCalls: number;
      proposals: number;
      verified: number;
      rejected: number;
      quoteFailures: number;
      declined: number;
      retries: number;
      timeouts: number;
      latencyMs: number;
      topicCandidates: number;
      changeCandidates: number;
      pairCandidates: number;
    };
  }[];
}
