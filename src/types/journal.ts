import { SttEngine, TranscriptionMetrics } from './stt';

export type MoodType = 'happy' | 'calm' | 'neutral' | 'stressed' | 'sad' | 'angry';

export type TopicType =
  | 'work_study'
  | 'relationships'
  | 'family'
  | 'health'
  | 'money'
  | 'goals'
  | 'leisure'
  | 'other';

export type ExtractionPath = 'llm' | 'llm_retry' | 'fallback';

export type TagStatus = 'ok' | 'retry_ok' | 'failed' | 'none';

export interface ExtractionData {
  mood: MoodType;
  topics: TopicType[];
  summary: string;
}

export interface JournalMetrics extends TranscriptionMetrics {
  llmTimeMs: number;
  retries: number;
  extractionPath: ExtractionPath;
}

export interface JournalEntryMetrics {
  audioLengthMs: number;
  sttMs: number;
  llmMs: number;
  retryCount: number;
}

export interface JournalEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Exactly what the STT engine returned, never edited. Kept to separate STT errors from model errors. */
  rawTranscript: string;
  /**
   * Engine that produced rawTranscript. Always set for new entries.
   * `null` only for entries saved before this column existed (engine unknown).
   */
  sttEngine: SttEngine | null;
  /** What the user reviewed and saved. */
  correctedTranscript: string;
  /** The user's one-tap mood choice; null if skipped. Never inferred from text. */
  moodSelection: MoodType | null;
  /** Tag list extracted or assigned. */
  tags: string[];
  /** Extraction pipeline health status. */
  tagStatus: TagStatus;
  /** Audio, STT, and LLM timing metrics. */
  metrics: JournalEntryMetrics;
}
