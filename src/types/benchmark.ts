import { MoodType, TopicType, ExtractionPath } from './journal';
import type { SttEngine } from './stt';

export interface BenchmarkDatasetItem {
  id: string;
  text: string;
  language: 'en' | 'hinglish';
  mood: MoodType;
  topics: TopicType[];
}

export interface BenchmarkEntryResult {
  id: string;
  language: 'en' | 'hinglish';
  groundTruth: {
    mood: MoodType;
    topics: TopicType[];
  };
  pipelineResult: {
    predictedMood: MoodType;
    predictedTopics: TopicType[];
    summary: string;
    path: ExtractionPath;
    llmLatencyMs: number;
    retryCount: number;
    firstAttemptValid: boolean;
  };
  fallbackBaseline: {
    predictedMood: MoodType;
    predictedTopics: TopicType[];
    summary: string;
  };
}

export interface BenchmarkResultsPayload {
  timestamp: string; // ISO 8601
  modelName: string;
  modelId: string;
  languageConfig: string; // 'en'
  device: {
    brand: string;
    model: string;
    androidVersion: string;
    platform: string;
  };
  totalEntries: number;
  completedEntries: number;
  cancelled: boolean;
  results: BenchmarkEntryResult[];
  sttResults?: SttBenchmarkResultsPayload;
}

export interface SttReferenceItem {
  id: string;
  fileName: string;
  language: 'en' | 'hinglish';
  referenceTranscript: string;
  targetDurationSec: number;
  wordCount: number;
}

export interface SttBenchmarkEntryResult {
  id: string;
  fileName: string;
  language: 'en' | 'hinglish';
  /** Engine that produced (or would have produced) hypothesisTranscript. */
  sttEngine: SttEngine;
  referenceTranscript: string;
  hypothesisTranscript: string | null;
  status: 'completed' | 'not_measured' | 'error';
  wer: number | null;
  substitutions: number | null;
  deletions: number | null;
  insertions: number | null;
  transcriptionTimeMs: number | null;
  audioDurationMs: number | null;
  errorMessage?: string;
}

export interface SttBenchmarkResultsPayload {
  timestamp: string; // ISO 8601
  modelName: string;
  /** Engine used for this run. Each entry also records its own sttEngine. */
  sttEngine: SttEngine;
  languageSetting: 'en' | 'hi';
  device: {
    brand: string;
    model: string;
    androidVersion: string;
    platform: string;
  };
  totalClips: number;
  measuredClips: number;
  averageWer: number | null;
  averageTranscriptionTimeMs: number | null;
  results: SttBenchmarkEntryResult[];
}
