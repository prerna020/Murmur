export interface TranscriptionMetrics {
  /** Length of the recorded audio in milliseconds */
  audioLengthMs: number;
  /** Time taken to perform transcription on-device in milliseconds */
  transcriptionTimeMs: number;
  /** Real-time factor: transcriptionTimeMs / audioLengthMs */
  realTimeFactor: number;
  /** Total raw audio samples recorded at 16 kHz */
  sampleCount: number;
}

export interface TranscriptionEntry {
  id: string;
  createdAt: number;
  transcript: string;
  metrics: TranscriptionMetrics;
}

export type PermissionState = 'checking' | 'granted' | 'denied' | 'permanently_denied';

export type RecordingStatus = 'idle' | 'recording' | 'transcribing' | 'error';

/**
 * Which speech-to-text engine produced a transcript.
 * - whisper_small_en: Whisper small.en via react-native-executorch (English tab, default).
 * - whisper_base_en: Whisper base.en. Only selectable with the dev tools switch, for timing.
 * - android_ondevice_hi: Android's on-device SpeechRecognizer, locale hi-IN (Hindi tab).
 */
export type SttEngine = 'whisper_small_en' | 'whisper_base_en' | 'android_ondevice_hi';

export const STT_ENGINES: readonly SttEngine[] = [
  'whisper_small_en',
  'whisper_base_en',
  'android_ondevice_hi',
];

export function isSttEngine(value: unknown): value is SttEngine {
  return typeof value === 'string' && (STT_ENGINES as readonly string[]).includes(value);
}

/** Human-readable label. `null` means the entry was saved before engine tracking existed. */
export function sttEngineLabel(engine: SttEngine | null): string {
  if (engine === 'whisper_small_en') return 'Whisper small.en (on-device)';
  if (engine === 'whisper_base_en') return 'Whisper base.en (on-device)';
  if (engine === 'android_ondevice_hi') return 'Android on-device recognizer (hi-IN)';
  return 'Engine not recorded';
}
