import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  ScrollView,
  Alert,
  AppState,
  TouchableOpacity,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { File } from 'expo-file-system';
import {
  setTelemetryEnabled,
  useSpeechToText,
  useLLMChatSession,
} from 'react-native-executorch';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  useAudioStream,
  setAudioModeAsync,
} from 'expo-audio';

import { PermissionState, RecordingStatus, SttEngine, sttEngineLabel } from './src/types/stt';
import { JournalEntry, MoodType, TopicType, TagStatus } from './src/types/journal';
import { PermissionPrompt } from './src/components/PermissionPrompt';
import { ModelProgress } from './src/components/ModelProgress';
import { RecordButton } from './src/components/RecordButton';
import { TranscriptReviewCard } from './src/components/TranscriptReviewCard';
import { PastEntriesList } from './src/components/PastEntriesList';
import {
  getDatabase,
  getAllJournalEntries,
  saveJournalEntrySafely,
  updateJournalEntryTranscript,
  updateJournalEntryMetadata,
  resetEncryptedDatabase,
  updateJournalEntryTagMetrics,
  DatabaseEncryptionError,
} from './src/services/database';
import {
  cleanupOrphanedAudioFiles,
  deleteAudioFileSilently,
} from './src/services/audioCleanup';
import {
  suggestTopicTags,
  TagAttemptTimeoutError,
  type LlmCallResult,
  type TagSuggestionResult,
} from './src/services/tagSuggestion';
import { addTag, addTagErrorMessage } from './src/services/tags';
import {
  ACTIVE_LLM_CONFIG,
  DEFAULT_STT_LANGUAGE,
  TAG_GENERATION_CONFIG,
  TAG_ATTEMPT_TIMEOUT_MS,
  TAG_STOP_GRACE_MS,
  INSIGHT_GENERATION_CONFIG,
  INSIGHT_ATTEMPT_TIMEOUT_MS,
} from './src/config/modelConfig';
import { generateWeeklyInsight } from './src/services/insight';
import type { CandidatePair } from './src/services/insightPairs';
import {
  useHindiRecognizer,
  HindiGateError,
  hindiErrorMessage,
  type HindiSessionResult,
} from './src/hooks/useHindiRecognizer';
import { HindiPackGate } from './src/components/HindiPackGate';
import { DEV_TOOLS_ENABLED } from './src/config/devTools';
import {
  WHISPER_VARIANTS,
  getWhisperVariant,
  type WhisperVariantId,
} from './src/config/whisperVariants';
import { saveDraft, loadDraft, deleteDraft } from './src/services/drafts';
import {
  draftAudioUri,
  type EntryDraft,
  type ReviewDraft,
  type TranscribingDraft,
} from './src/services/draftSchema';
import { decodeWavBytes } from './src/utils/wavDecoder';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  clearReminder,
  installNotificationHandler,
  syncReminderOnLaunch,
} from './src/services/reminders';
import {
  deleteAllTempAudio,
  deleteBenchmarkClips,
  deleteDownloadedModels,
} from './src/services/storage';
import { hindiGateMessage } from './src/services/hindiGate';
import { BenchmarkRunnerScreen } from './src/screens/BenchmarkRunnerScreen';
import { WeeklyRecapView } from './src/components/WeeklyRecapView';
import { convertDevanagariToHinglish } from './src/services/hinglishTransliteration';

// Opt out of anonymous download telemetry immediately — 100% private
setTelemetryEnabled(false);

const MAX_RECORDING_SECONDS = 60;
const SAMPLE_RATE = 16000;

/**
 * Logs one [TAG-TIMING] line per attempt and one [TAG-RESULT] line per entry.
 * Metadata only: no transcript text, no model output, no tag names.
 */
function logTagRun(
  runId: string,
  sttEngine: SttEngine,
  transcriptChars: number,
  result: TagSuggestionResult,
  whisperLoaded: boolean
): void {
  const build = __DEV__ ? 'debug-js' : 'release-js';
  for (const a of result.attempts) {
    console.log(
      '[TAG-TIMING] ' +
        JSON.stringify({
          build,
          run: runId,
          enableThinking: TAG_GENERATION_CONFIG.enableThinking ?? null,
          maxNewTokens: TAG_GENERATION_CONFIG.maxNewTokens ?? null,
          attempt: a.attempt,
          outcome: a.outcome,
          validated: a.outcome === 'valid',
          attemptMs: a.attemptMs,
          firstTokenMs: a.stats?.firstTokenMs ?? null,
          totalMs: a.stats?.totalMs ?? null,
          tokensGenerated: a.stats?.tokensGenerated ?? null,
          promptTokens: a.stats?.promptTokens ?? null,
          prefillMs: a.stats?.prefillMs ?? null,
          decodeMs: a.stats?.decodeMs ?? null,
          finishReason: a.stats?.finishReason ?? null,
          hadThinkBlock: a.stats?.hadThinkBlock ?? null,
          rawChars: a.stats?.rawChars ?? null,
          answerChars: a.stats?.answerChars ?? null,
          promptChars: a.promptChars,
          modelLoaded: a.stats?.modelLoaded ?? null,
          modelSessionId: a.stats?.modelSessionId ?? null,
          callIndexInSession: a.stats?.callIndexInSession ?? null,
          whisperLoaded,
        })
    );
  }
  console.log(
    '[TAG-RESULT] ' +
      JSON.stringify({
        build,
        run: runId,
        sttEngine,
        transcriptChars,
        status: result.status,
        retryCount: result.retryCount,
        tagCount: result.tags.length,
        llmMs: result.llmMs,
      })
  );
}

export default function App() {
  // Permission state
  const [permissionState, setPermissionState] = useState<PermissionState>('checking');

  // Retry key to force model reloading if needed
  const [modelReloadKey, setModelReloadKey] = useState(0);

  // Speech-to-text tab.
  // 'en' -> Whisper small.en on-device (sttEngine 'whisper_small_en').
  // 'hi' -> Android's on-device recognizer, hi-IN (sttEngine 'android_ondevice_hi').
  const [sttLanguage, setSttLanguage] = useState<'hi' | 'en'>(DEFAULT_STT_LANGUAGE);

  // 1. Whisper STT model hook, English only. It stays loaded on both tabs, so
  // switching tabs never swaps models. The variant is 'default' unless changed
  // with the dev tools switch (timing only; not available in normal releases).
  const [whisperVariantId, setWhisperVariantId] = useState<WhisperVariantId>('default');
  const whisperVariant = getWhisperVariant(whisperVariantId);
  const sttModelConfig = whisperVariant.config;
  const stt = useSpeechToText(sttModelConfig);

  // The full-screen download gate is only for first launch.
  const hasLoadedModelsRef = useRef(false);

  // 2. Active on-device LLM model hook (Structured Extraction)
  const llm = useLLMChatSession(ACTIVE_LLM_CONFIG.source, { resetOnTurn: true });

  // Benchmark modal visibility (accessible only in __DEV__)
  const [showBenchmark, setShowBenchmark] = useState(false);

  // Recording & processing states
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  // Latest values for the AppState listener, which is registered once.
  const recordingStatusRef = useRef<RecordingStatus>('idle');
  const sttLanguageRef = useRef<'hi' | 'en'>(DEFAULT_STT_LANGUAGE);
  useEffect(() => {
    recordingStatusRef.current = recordingStatus;
    sttLanguageRef.current = sttLanguage;
  }, [recordingStatus, sttLanguage]);
  const [processingStage, setProcessingStage] = useState<string>('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sub-stage 2A: Navigation tab ('journal' | 'recap')
  const [activeTab, setActiveTab] = useState<'journal' | 'recap' | 'settings'>('journal');

  // Past journal entries from local encrypted SQLite
  const [pastEntries, setPastEntries] = useState<JournalEntry[]>([]);
  // Database encryption / decryption error message
  const [dbError, setDbError] = useState<string | null>(null);

  const loadPastEntries = useCallback(async () => {
    try {
      setDbError(null);
      await getDatabase();
      const entries = await getAllJournalEntries();
      setPastEntries(entries);
    } catch (err: unknown) {
      if (err instanceof DatabaseEncryptionError) {
        setDbError(err.message);
      } else {
        setDbError('Failed to initialize encrypted SQLite database.');
      }
    }
  }, []);

  // Sub-stage 1B: Pending Review State
  interface PendingReviewData {
    /** Changes for each new review so the card remounts with fresh state. */
    key: string;
    rawTranscript: string;
    initialTranscript: string;
    sttEngine: SttEngine;
    audioLengthMs: number;
    sttMs: number;
    tempAudioUri: string | null;
    /** When recording stopped. Used as the entry's createdAt. */
    recordedAt: number;
    /** Edits restored from a draft after a restart. */
    restored: { editedTranscript: string; mood: MoodType | null; tags: string[] } | null;
  }
  const [pendingReview, setPendingReview] = useState<PendingReviewData | null>(null);
  // A recording whose transcription was interrupted (app killed). Finished once Whisper is ready.
  const [recoveryDraft, setRecoveryDraft] = useState<TranscribingDraft | null>(null);
  const [isSavingEntry, setIsSavingEntry] = useState<boolean>(false);
  const [saveEntryError, setSaveEntryError] = useState<string | null>(null);

  // Sub-stage 1C: Mood & Tag suggestion state
  const [suggestedTags, setSuggestedTags] = useState<TopicType[]>([]);
  const [isSuggestingTags, setIsSuggestingTags] = useState<boolean>(false);
  /**
   * One tag-suggestion run per reviewed entry. Each run keeps its own result and
   * the id of the entry it belongs to once saved, so a late result can never be
   * applied to a different entry.
   */
  interface TagRun {
    meta: { status: TagStatus; llmMs: number; retryCount: number } | null;
    savedEntryId: string | null;
  }
  const activeTagRunRef = useRef<TagRun | null>(null);
  // Model work runs one task at a time: the model accepts one call at a time.
  const llmQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [lateSuggestionPrompt, setLateSuggestionPrompt] = useState<{
    entryId: string;
    suggestedTags: TopicType[];
  } | null>(null);

  // Audio capture buffers & references
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const recordedFileUriRef = useRef<string | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audio stream hook for capturing 16kHz mono Float32 PCM
  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: 'float32',
    onBuffer: (buffer) => {
      if (buffer.data && buffer.data.byteLength > 0) {
        // Clone buffer memory so native JNI/ArrayBuffer reuse never corrupts past chunks
        pcmChunksRef.current.push(new Float32Array(buffer.data.slice(0)));
      }
    },
  });

  // Check microphone permission, clean orphaned audio, and load past entries on mount
  useEffect(() => {
    async function init() {
      // Initialize Encrypted Database and load past entries
      await loadPastEntries();

      // Restore an entry that was in progress when the app was killed.
      let draft: EntryDraft | null = null;
      try {
        draft = await loadDraft();
      } catch {
        draft = null;
      }

      // Delete temporary audio left by a crash or force-close, except the file
      // the restored draft still needs.
      cleanupOrphanedAudioFiles([draftAudioUri(draft)]);

      // Local reminder: show it in the foreground too, and make the OS schedule
      // match the saved setting.
      installNotificationHandler();
      syncReminderOnLaunch().catch(() => undefined);

      if (draft?.stage === 'review') {
        restoreReviewDraft(draft);
      } else if (draft?.stage === 'transcribing') {
        if (new File(draft.audioUri).exists) {
          setRecoveryDraft(draft);
        } else {
          await deleteDraft().catch(() => undefined);
        }
      }

      // Check mic permission
      try {
        const response = await getRecordingPermissionsAsync();
        if (response.granted) {
          setPermissionState('granted');
        } else if (!response.canAskAgain) {
          setPermissionState('permanently_denied');
        } else {
          setPermissionState('denied');
        }
      } catch {
        setPermissionState('denied');
      }
    }
    init();
  }, []);

  const handleResetDatabase = async () => {
    Alert.alert(
      'Reset Encrypted Database',
      'This will delete the existing encrypted database and regenerate a new encryption key in Android Keystore. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Database',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetEncryptedDatabase();
              setDbError(null);
              const entries = await getAllJournalEntries();
              setPastEntries(entries);
            } catch (err: unknown) {
              setDbError(err instanceof Error ? err.message : 'Database reset failed.');
            }
          },
        },
      ]
    );
  };

  const handleSaveEntry = async (
    editedTranscript: string,
    mood: MoodType | null,
    tags: string[]
  ) => {
    if (!pendingReview) return;
    setIsSavingEntry(true);
    setSaveEntryError(null);

    const entryId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    // Dated by when it was recorded, which matters for restored drafts.
    const createdAt = pendingReview.recordedAt;

    // tagStatus describes the model's suggestion run, not the user's tags. If the
    // run has not finished yet it is 'none' here and is updated when it finishes.
    const run = activeTagRunRef.current;
    const finalTagStatus: TagStatus = run?.meta?.status ?? 'none';
    const currentMeta = { llmMs: run?.meta?.llmMs ?? 0, retryCount: run?.meta?.retryCount ?? 0 };

    const journalEntry: JournalEntry = {
      id: entryId,
      createdAt,
      updatedAt: createdAt,
      rawTranscript: pendingReview.rawTranscript, // untouched STT engine output
      sttEngine: pendingReview.sttEngine,
      correctedTranscript: editedTranscript, // what the user reviewed and saved
      moodSelection: mood, // 1-tap user selection or null
      tags, // tags array (custom + standard)
      tagStatus: finalTagStatus,
      metrics: {
        audioLengthMs: pendingReview.audioLengthMs,
        sttMs: pendingReview.sttMs,
        llmMs: currentMeta.llmMs,
        retryCount: currentMeta.retryCount,
      },
    };

    // Sub-stage 1B & 1C Order of Operations:
    // (1) Write entry to encrypted DB
    // (2) Confirm write succeeded
    // (3) ONLY THEN delete temporary audio file
    const result = await saveJournalEntrySafely(journalEntry, pendingReview.tempAudioUri);

    if (result.success) {
      if (run && !run.meta) {
        // Suggestion still running: its result will be recorded on this entry.
        run.savedEntryId = entryId;
      }
      activeTagRunRef.current = null;
      setIsSuggestingTags(false);
      cancelDraftWrite();
      await deleteDraft().catch(() => undefined);
      setPendingReview(null);
      setIsSavingEntry(false);
      recordedFileUriRef.current = null;
      const updatedList = await getAllJournalEntries();
      setPastEntries(updatedList);
    } else {
      setIsSavingEntry(false);
      setSaveEntryError(result.error || 'Failed to save entry to database.');
    }
  };

  const handleDiscardEntry = () => {
    if (pendingReview?.tempAudioUri) {
      deleteAudioFileSilently(pendingReview.tempAudioUri);
    }
    setPendingReview(null);
    setSaveEntryError(null);
    setIsSavingEntry(false);
    setSuggestedTags([]);
    setIsSuggestingTags(false);
    // A discarded entry's run finishes in the background and its result is dropped.
    activeTagRunRef.current = null;
    recordedFileUriRef.current = null;
    cancelDraftWrite();
    deleteDraft().catch(() => undefined);
  };

  /**
   * Settings → Delete all data. Order: stop background work, cancel the
   * reminder, delete temporary audio and benchmark clips, then delete the
   * encrypted database and its Keystore key (a new empty database with a new
   * key is created). Models are deleted only when asked.
   */
  const handleDeleteAll = async (alsoModels: boolean) => {
    if (recordingStatus === 'recording' || recordingStatus === 'transcribing') {
      throw new Error('Stop the current recording first.');
    }
    activeTagRunRef.current = null;
    cancelDraftWrite();
    await clearReminder().catch(() => undefined);
    deleteAllTempAudio();
    deleteBenchmarkClips();
    await resetEncryptedDatabase();
    if (alsoModels) await deleteDownloadedModels();

    setPendingReview(null);
    setRecoveryDraft(null);
    setLateSuggestionPrompt(null);
    setSuggestedTags([]);
    setIsSuggestingTags(false);
    setErrorMessage(null);
    setPastEntries([]);
    recordedFileUriRef.current = null;
    pcmChunksRef.current = [];
  };

  const handleAcceptLateTag = async (tag: string) => {
    if (!lateSuggestionPrompt) return;
    const entry = pastEntries.find((e) => e.id === lateSuggestionPrompt.entryId);
    if (entry) {
      const added = addTag(entry.tags, tag);
      if (!added.ok) {
        Alert.alert('Tag not added', addTagErrorMessage(added.reason));
        return;
      }
      await updateJournalEntryMetadata(
        entry.id,
        entry.moodSelection,
        added.tags,
        entry.tagStatus,
        entry.metrics.llmMs,
        entry.metrics.retryCount
      );
      const updatedList = await getAllJournalEntries();
      setPastEntries(updatedList);
    }
  };

  const handleUpdateEntry = async (id: string, newTranscript: string) => {
    await updateJournalEntryTranscript(id, newTranscript);
    const updatedList = await getAllJournalEntries();
    setPastEntries(updatedList);
  };

  const handleRequestPermission = async () => {
    try {
      const response = await requestRecordingPermissionsAsync();
      if (response.granted) {
        setPermissionState('granted');
      } else if (!response.canAskAgain) {
        setPermissionState('permanently_denied');
      } else {
        setPermissionState('denied');
      }
    } catch {
      setPermissionState('denied');
    }
  };

  const handleRetryModel = () => {
    setModelReloadKey((prev) => prev + 1);
  };

  // Clean up recorded audio file from disk
  const cleanupAudioFile = (uri: string | null) => {
    deleteAudioFileSilently(uri || recordedFileUriRef.current);
    recordedFileUriRef.current = null;
    pcmChunksRef.current = [];
  };

  // Tracks whether the LLM session is reused or re-created between entries.
  // The id increments each time the library hands out a new sendMessage
  // function, which happens only when the model session is (re)created.
  const llmSessionRef = useRef<{
    id: number;
    calls: number;
    fn: typeof llm.sendMessage;
  }>({ id: 0, calls: 0, fn: undefined });
  useEffect(() => {
    if (llm.sendMessage && llm.sendMessage !== llmSessionRef.current.fn) {
      llmSessionRef.current = {
        id: llmSessionRef.current.id + 1,
        calls: 0,
        fn: llm.sendMessage,
      };
    }
  }, [llm.sendMessage]);

  /**
   * One measured model call with a hard timeout. Used for tag suggestions and
   * the weekly insight. On timeout the model is stopped and
   * TagAttemptTimeoutError is thrown.
   */
  const callLLMWithStats = useCallback(
    async (
      prompt: string,
      genConfig: typeof TAG_GENERATION_CONFIG,
      timeoutMs: number
    ): Promise<LlmCallResult> => {
      const modelLoaded = Boolean(llm.isReady);
      if (!llm.sendMessage) {
        throw new Error('LLM session is not ready');
      }
      const session = llmSessionRef.current;
      session.calls += 1;
      const callIndexInSession = session.calls;

      const start = performance.now();
      let firstTokenAt: number | null = null;
      let streamed = '';
      const turnPromise = llm.sendMessage(
        prompt,
        (token) => {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          streamed += token;
        },
        genConfig
      );

      // Hard timeout. On expiry: stop generation, wait (briefly) until the library
      // has released the turn so the retry is not rejected as busy, then fail.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      let first: Awaited<typeof turnPromise> | 'timeout';
      try {
        first = await Promise.race([turnPromise, timedOut]);
      } finally {
        clearTimeout(timer);
      }
      if (first === 'timeout') {
        llm.stop?.();
        await Promise.race([
          turnPromise.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, TAG_STOP_GRACE_MS)),
        ]);
        throw new TagAttemptTimeoutError(timeoutMs);
      }
      const turn = first;
      const totalMs = Math.round(performance.now() - start);

      const assistantMsg = turn.messages.find((m) => m.role === 'assistant');
      const fallbackMsg = typeof assistantMsg?.content === 'string' ? assistantMsg.content : '';
      const rawMsg = streamed || fallbackMsg;
      const answer = rawMsg
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .trim();

      const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
      const hasStats = turn.stats.length > 0;
      return {
        text: answer,
        stats: {
          firstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - start),
          totalMs,
          tokensGenerated: hasStats ? sum(turn.stats.map((s) => s.numTokens)) : null,
          // The first step's prefill covers the prompt.
          promptTokens: hasStats ? turn.stats[0].prefill.numTokens : null,
          prefillMs: hasStats ? Math.round(turn.stats[0].prefill.durationMs) : null,
          decodeMs: hasStats ? Math.round(sum(turn.stats.map((s) => s.durationMs))) : null,
          finishReason: turn.finishReason,
          rawChars: rawMsg.length,
          answerChars: answer.length,
          hadThinkBlock: /<think>/i.test(rawMsg),
          modelLoaded,
          modelSessionId: session.id,
          callIndexInSession,
        },
      };
    },
    [llm]
  );

  const sendLLMWithStats = useCallback(
    (prompt: string) => callLLMWithStats(prompt, TAG_GENERATION_CONFIG, TAG_ATTEMPT_TIMEOUT_MS),
    [callLLMWithStats]
  );

  /**
   * Runs model work one task at a time (the model rejects a second call while
   * one is running). Tag suggestions and the weekly insight share this queue.
   */
  const enqueueLLM = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = llmQueueRef.current.then(task, task);
    llmQueueRef.current = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }, []);

  // Benchmark runner hooks (dev tools only). Tags go through the same queue and
  // settings as live entries, so the benchmark measures what the app does.
  const benchmarkSuggestTags = useCallback(
    (text: string) => enqueueLLM(() => suggestTopicTags(text, sendLLMWithStats)),
    [enqueueLLM, sendLLMWithStats]
  );
  const benchmarkTranscribeEnglish = useCallback(
    async (samples: Float32Array) => {
      if (!stt.transcribe) throw new Error('Whisper is not ready');
      return stt.transcribe(samples, { language: 'en' });
    },
    [stt]
  );

  const runInsight = useCallback(
    (pairs: CandidatePair[]) =>
      enqueueLLM(() =>
        generateWeeklyInsight(pairs, (prompt) =>
          callLLMWithStats(prompt, INSIGHT_GENERATION_CONFIG, INSIGHT_ATTEMPT_TIMEOUT_MS)
        )
      ),
    [enqueueLLM, callLLMWithStats]
  );

  // ---- Draft persistence for the entry under review ----
  // Edits are written to the encrypted drafts table 600 ms after the last change.
  const draftWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDraftWrite = () => {
    if (draftWriteTimerRef.current) {
      clearTimeout(draftWriteTimerRef.current);
      draftWriteTimerRef.current = null;
    }
  };
  const handleDraftChange = (editedTranscript: string, mood: MoodType | null, tags: string[]) => {
    const review = pendingReview;
    if (!review) return;
    cancelDraftWrite();
    draftWriteTimerRef.current = setTimeout(() => {
      draftWriteTimerRef.current = null;
      saveDraft({
        stage: 'review',
        sttEngine: review.sttEngine,
        rawTranscript: review.rawTranscript,
        initialTranscript: review.initialTranscript,
        editedTranscript,
        mood,
        tags,
        audioLengthMs: review.audioLengthMs,
        sttMs: review.sttMs,
        tempAudioUri: review.tempAudioUri,
        recordedAt: review.recordedAt,
      }).catch(() => undefined);
    }, 600);
  };

  /**
   * Opens the review card for a fresh transcript and starts tag suggestions in
   * the background. Shared by both engines.
   * rawTranscript is stored exactly as the engine returned it. The editable draft
   * only converts Devanagari words to Roman script (no word substitution).
   */
  const beginReview = useCallback(
    (args: {
      rawTranscript: string;
      audioLengthMs: number;
      sttMs: number;
      tempAudioUri: string | null;
      sttEngine: SttEngine;
      recordedAt: number;
      restored?: PendingReviewData['restored'];
    }) => {
      const reviewTranscript = convertDevanagariToHinglish(args.rawTranscript);
      const restored = args.restored ?? null;

      setPendingReview({
        key: `${args.recordedAt}`,
        rawTranscript: args.rawTranscript,
        initialTranscript: reviewTranscript,
        sttEngine: args.sttEngine,
        audioLengthMs: args.audioLengthMs,
        sttMs: args.sttMs,
        tempAudioUri: args.tempAudioUri,
        recordedAt: args.recordedAt,
        restored,
      });

      // Keep the entry if the app is killed while it is being reviewed.
      saveDraft({
        stage: 'review',
        sttEngine: args.sttEngine,
        rawTranscript: args.rawTranscript,
        initialTranscript: reviewTranscript,
        editedTranscript: restored?.editedTranscript ?? reviewTranscript,
        mood: restored?.mood ?? null,
        tags: restored?.tags ?? [],
        audioLengthMs: args.audioLengthMs,
        sttMs: args.sttMs,
        tempAudioUri: args.tempAudioUri,
        recordedAt: args.recordedAt,
      }).catch(() => undefined);

      setRecordingStatus('idle');
      setProcessingStage('');
      setSaveEntryError(null);

      // Sub-stage 1C: on-device tag suggestion in the background (non-blocking).
      // A restored draft waits until the model has loaded (see effect below).
      setSuggestedTags([]);
      if (restored) {
        activeTagRunRef.current = null;
        setIsSuggestingTags(false);
      } else {
        startTagSuggestion(reviewTranscript, args.sttEngine);
      }
    },
    // startTagSuggestion is stable for a given model session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendLLMWithStats, stt.isReady]
  );

  /** Starts one background tag run for the entry under review. */
  const startTagSuggestion = useCallback(
    (transcript: string, sttEngine: SttEngine) => {
      setIsSuggestingTags(true);
      const run: TagRun = { meta: null, savedEntryId: null };
      activeTagRunRef.current = run;
      const tagRunId = Date.now().toString(36);
      const whisperLoaded = Boolean(stt.isReady);

      enqueueLLM(async () => {
        let result: TagSuggestionResult;
        try {
          result = await suggestTopicTags(transcript, sendLLMWithStats);
        } catch {
          result = { tags: [], status: 'failed', llmMs: 0, retryCount: 1, attempts: [] };
        }
        logTagRun(tagRunId, sttEngine, transcript.length, result, whisperLoaded);
        run.meta = { status: result.status, llmMs: result.llmMs, retryCount: result.retryCount };

        if (run.savedEntryId) {
          // Saved before the run finished: record the outcome on that entry only.
          // The user's tags are never changed; suggestions are offered as a prompt.
          const savedId = run.savedEntryId;
          try {
            await updateJournalEntryTagMetrics(savedId, result.status, result.llmMs, result.retryCount);
            setPastEntries(await getAllJournalEntries());
          } catch {
            // Metrics only; ignore write errors.
          }
          if (result.tags.length > 0) {
            setLateSuggestionPrompt({ entryId: savedId, suggestedTags: result.tags });
          }
        } else if (activeTagRunRef.current === run) {
          setSuggestedTags(result.tags);
          setIsSuggestingTags(false);
        }
      });
    },
    [sendLLMWithStats, stt.isReady, enqueueLLM]
  );

  /** Re-opens a review that was in progress when the app was killed. */
  const restoreReviewDraft = (draft: ReviewDraft) => {
    beginReview({
      rawTranscript: draft.rawTranscript,
      audioLengthMs: draft.audioLengthMs,
      sttMs: draft.sttMs,
      tempAudioUri: draft.tempAudioUri,
      sttEngine: draft.sttEngine,
      recordedAt: draft.recordedAt,
      restored: { editedTranscript: draft.editedTranscript, mood: draft.mood, tags: draft.tags },
    });
  };

  // Suggest tags for a restored draft once the model is ready, only if the
  // user had not picked any tags yet. Runs once per restored review.
  const restoredSuggestionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!llm.isReady || !pendingReview?.restored) return;
    if (restoredSuggestionKeyRef.current === pendingReview.key) return;
    restoredSuggestionKeyRef.current = pendingReview.key;
    if (pendingReview.restored.tags.length === 0) {
      startTagSuggestion(pendingReview.restored.editedTranscript, pendingReview.sttEngine);
    }
  }, [llm.isReady, pendingReview, startTagSuggestion]);

  // ---- Hindi / Hinglish: Android on-device recognizer ----
  const handleHindiFinished = useCallback(
    (result: HindiSessionResult) => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }

      if (result.errorCode === 'aborted') {
        setRecordingStatus('idle');
        setProcessingStage('');
        return;
      }

      if (!result.transcript.trim()) {
        setErrorMessage(
          result.errorCode
            ? hindiErrorMessage(result.errorCode)
            : 'No speech could be recognized in the recording.'
        );
        setRecordingStatus('idle');
        setProcessingStage('');
        return;
      }

      // The recognizer may end a session on its own (for example after an
      // error). Keep what it recognized, and say so.
      if (!result.stoppedByUser) {
        setErrorMessage(
          result.errorCode
            ? `Recording stopped early: ${hindiErrorMessage(result.errorCode)} The words recognized so far are below.`
            : 'The recognizer ended the recording early. The words recognized so far are below.'
        );
      }

      beginReview({
        rawTranscript: result.transcript,
        audioLengthMs: result.audioLengthMs,
        sttMs: result.finalizeMs,
        tempAudioUri: null, // the recognizer keeps no audio file
        sttEngine: 'android_ondevice_hi',
        recordedAt: Date.now(),
      });
    },
    [beginReview]
  );

  const hindi = useHindiRecognizer({
    active: sttLanguage === 'hi',
    onFinished: handleHindiFinished,
  });

  const stopHindiRecording = useCallback(() => {
    if (recordingStatus !== 'recording') return;
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    setRecordingStatus('transcribing');
    setProcessingStage('Finishing on-device Hindi recognition...');
    hindi.stop();
  }, [recordingStatus, hindi]);

  const startHindiRecording = async () => {
    setErrorMessage(null);
    setElapsedSeconds(0);
    try {
      // Re-checks the hard gate. Throws HindiGateError, and never starts, if it fails.
      await hindi.start();
    } catch (err: unknown) {
      if (err instanceof HindiGateError) {
        setErrorMessage(hindiGateMessage(err.gate.reason));
      } else {
        Alert.alert('Recording Error', err instanceof Error ? err.message : 'Failed to start');
      }
      setRecordingStatus('idle');
      return;
    }

    setRecordingStatus('recording');
    const startTime = Date.now();
    timerIntervalRef.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startTime) / 1000);
      setElapsedSeconds(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) {
        hindiStopRef.current();
      }
    }, 250);
  };

  // The 60 s timer must call the latest stop function, not the one captured at start.
  const hindiStopRef = useRef(stopHindiRecording);
  useEffect(() => {
    hindiStopRef.current = stopHindiRecording;
  }, [stopHindiRecording]);

  /**
   * Whisper transcription of a finished English recording. Used right after a
   * recording, and to finish a recording whose transcription was interrupted
   * because the app was killed (the WAV file and a draft are kept for that).
   */
  const transcribeEnglish = useCallback(
    async (
      samples: Float32Array,
      meta: {
        audioUri: string | null;
        recordedAt: number;
        pcmMergeMs: number;
        source: 'live' | 'recovered';
      }
    ) => {
      setRecordingStatus('transcribing');
      setProcessingStage(
        'Transcribing on-device (Whisper). You can switch tabs; if you leave the app, the recording is kept and finished next time.'
      );
      try {
        if (!stt.transcribe) {
          throw new Error('Whisper transcriber is not initialized');
        }
        const audioLengthMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
        const sttStart = performance.now();
        // Token arrival times, used only for the timing log below (no text is logged).
        const tokenTimes: number[] = [];
        const transcribedText = await stt.transcribe(samples, { language: 'en' }, () => {
          tokenTimes.push(performance.now());
        });
        const sttMs = Math.round(performance.now() - sttStart);

        // Timing split. Whisper processes audio in 29 s windows, and each window
        // runs the encoder once before decoding tokens. The encoder is not
        // instrumented inside the library, so its time shows up as the delay before
        // the first token and as the biggest gap between tokens (second window).
        const firstTokenMs = tokenTimes.length ? Math.round(tokenTimes[0] - sttStart) : null;
        let maxGapMs = 0;
        for (let i = 1; i < tokenTimes.length; i++) {
          maxGapMs = Math.max(maxGapMs, Math.round(tokenTimes[i] - tokenTimes[i - 1]));
        }
        console.log(
          '[STT-TIMING] ' +
            JSON.stringify({
              build: __DEV__ ? 'debug-js' : 'release-js',
              devTools: DEV_TOOLS_ENABLED,
              source: meta.source,
              engine: whisperVariant.engine,
              variant: whisperVariant.id,
              modelPath: sttModelConfig.modelPath,
              audioMs: audioLengthMs,
              pcmMergeMs: meta.pcmMergeMs,
              windows: Math.ceil(samples.length / (29 * SAMPLE_RATE)),
              tokens: tokenTimes.length,
              firstTokenMs,
              maxTokenGapMs: maxGapMs,
              totalMs: sttMs,
            })
        );

        if (!transcribedText.trim()) {
          setErrorMessage('No speech could be recognized in the recording.');
          setRecordingStatus('idle');
          setProcessingStage('');
          deleteAudioFileSilently(meta.audioUri);
          await deleteDraft().catch(() => undefined);
          return;
        }

        // Editable review card. The audio stays on disk until the save is confirmed.
        beginReview({
          rawTranscript: transcribedText,
          audioLengthMs,
          sttMs,
          tempAudioUri: meta.audioUri,
          sttEngine: whisperVariant.engine,
          recordedAt: meta.recordedAt,
        });
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Transcription failed');
        setRecordingStatus('error');
        setProcessingStage('');
        deleteAudioFileSilently(meta.audioUri);
        await deleteDraft().catch(() => undefined);
      }
    },
    [stt, beginReview, whisperVariant, sttModelConfig.modelPath]
  );

  // Stop the English recording, keep it as a draft, then transcribe it.
  const stopRecordingAndProcess = useCallback(async () => {
    if (recordingStatus !== 'recording') return;

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    setRecordingStatus('transcribing');
    setProcessingStage('Finishing the recording...');
    setErrorMessage(null);
    const recordedAt = Date.now();

    let recordedUri: string | null = null;
    try {
      const fileResult = await stream.stopFileRecordingAsync().catch(() => null);
      if (fileResult?.uri) {
        recordedUri = fileResult.uri;
        recordedFileUriRef.current = fileResult.uri;
      }
      stream.stop();
    } catch {
      // Continue even if file stop fails; the raw PCM chunks are in memory.
    }

    const chunks = pcmChunksRef.current;
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSamples < SAMPLE_RATE * 0.3) {
      setErrorMessage('Recording was too short. Please speak for at least 1 second.');
      setRecordingStatus('idle');
      setProcessingStage('');
      cleanupAudioFile(recordedUri);
      return;
    }

    const mergeStart = performance.now();
    const mergedAudio = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      mergedAudio.set(chunk, offset);
      offset += chunk.length;
    }
    pcmChunksRef.current = [];
    const pcmMergeMs = Math.round(performance.now() - mergeStart);

    // If the app is killed during transcription, this draft and the WAV file
    // let the next launch finish it.
    if (recordedUri) {
      await saveDraft({
        stage: 'transcribing',
        sttEngine: whisperVariant.engine,
        audioUri: recordedUri,
        audioLengthMs: Math.round((totalSamples / SAMPLE_RATE) * 1000),
        recordedAt,
      }).catch(() => undefined);
    }

    await transcribeEnglish(mergedAudio, {
      audioUri: recordedUri,
      recordedAt,
      pcmMergeMs,
      source: 'live',
    });
    // cleanupAudioFile is a plain function recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingStatus, stream, transcribeEnglish, whisperVariant.engine]);

  // The 60 s timer and the background handler must call the latest stop function.
  const englishStopRef = useRef(stopRecordingAndProcess);
  useEffect(() => {
    englishStopRef.current = stopRecordingAndProcess;
  }, [stopRecordingAndProcess]);

  // Finish a recording whose transcription was interrupted by the app being killed.
  const recoveryStartedRef = useRef(false);
  useEffect(() => {
    if (!recoveryDraft || recoveryStartedRef.current) return;
    if (!stt.isReady || recordingStatus !== 'idle' || pendingReview) return;
    recoveryStartedRef.current = true;
    const draft = recoveryDraft;
    (async () => {
      let samples: Float32Array | null = null;
      try {
        const bytes = new Uint8Array(await new File(draft.audioUri).arrayBuffer());
        samples = decodeWavBytes(bytes).samples;
      } catch {
        samples = null;
      }
      setRecoveryDraft(null);
      recoveryStartedRef.current = false;
      if (!samples || samples.length < SAMPLE_RATE * 0.3) {
        setErrorMessage('An unfinished recording from last time could not be read, so it was removed.');
        deleteAudioFileSilently(draft.audioUri);
        await deleteDraft().catch(() => undefined);
        return;
      }
      setErrorMessage('Finishing a recording from last time that was not transcribed yet.');
      await transcribeEnglish(samples, {
        audioUri: draft.audioUri,
        recordedAt: draft.recordedAt,
        pcmMergeMs: 0,
        source: 'recovered',
      });
    })();
  }, [recoveryDraft, stt.isReady, recordingStatus, pendingReview, transcribeEnglish]);

  // Android may stop the microphone in the background. Stop and keep the
  // recording instead of losing it when the app is sent to the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background') return;
      if (recordingStatusRef.current !== 'recording') return;
      if (sttLanguageRef.current === 'hi') {
        hindiStopRef.current();
      } else {
        englishStopRef.current();
      }
    });
    return () => sub.remove();
  }, []);

  // Start recording
  const startRecording = async () => {
    try {
      setErrorMessage(null);
      pcmChunksRef.current = [];
      setElapsedSeconds(0);

      // Configure audio session for recording
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      // Start stream and file recording
      await stream.start();
      const fileRec = await stream.startFileRecordingAsync({ format: 'wav' });
      if (fileRec?.uri) {
        recordedFileUriRef.current = fileRec.uri;
      }

      setRecordingStatus('recording');

      // 60-second limit. Calls the latest stop function through a ref; the
      // closure captured here would see a stale recordingStatus and do nothing.
      const startTime = Date.now();
      timerIntervalRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        setElapsedSeconds(seconds);

        if (seconds >= MAX_RECORDING_SECONDS) {
          englishStopRef.current();
        }
      }, 250);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start recording';
      Alert.alert('Recording Error', msg);
      setRecordingStatus('idle');
    }
  };

  const handleToggleRecord = () => {
    if (pendingReview) {
      Alert.alert(
        'Review in Progress',
        'Please save or discard your current voice note before starting a new recording.'
      );
      return;
    }
    if (sttLanguage === 'hi') {
      if (recordingStatus === 'idle' || recordingStatus === 'error') {
        startHindiRecording();
      } else if (recordingStatus === 'recording') {
        stopHindiRecording();
      }
      return;
    }

    if (!stt.isReady) {
      Alert.alert(
        'Speech model loading',
        'The English speech model is still loading. Please wait a moment.'
      );
      return;
    }
    if (recordingStatus === 'idle' || recordingStatus === 'error') {
      startRecording();
    } else if (recordingStatus === 'recording') {
      stopRecordingAndProcess();
    }
  };

  const isBusy = recordingStatus === 'recording' || recordingStatus === 'transcribing';
  const hindiGateBlocks = sttLanguage === 'hi' && !(hindi.gate?.ok ?? false);

  // 1. Permission Gate
  if (permissionState !== 'granted') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <PermissionPrompt
          permissionState={permissionState}
          onRequestPermission={handleRequestPermission}
        />
      </SafeAreaView>
    );
  }

  // 2. Model Download / Readiness Gate (Whisper + Qwen)
  const isModelsReady = stt.isReady && llm.isReady;
  if (isModelsReady) {
    hasLoadedModelsRef.current = true;
  }
  if (!isModelsReady && !hasLoadedModelsRef.current) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <ModelProgress
          key={modelReloadKey}
          sttReady={stt.isReady}
          sttProgress={stt.downloadProgress}
          sttError={stt.error}
          llmReady={llm.isReady}
          llmProgress={llm.downloadProgress}
          llmError={llm.error}
          onRetry={handleRetryModel}
        />
      </SafeAreaView>
    );
  }

  // 3. Main Screen
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.brandTitle}>Murmur</Text>
          <View style={styles.headerRight}>
            <View style={styles.offlineBadge}>
              <View style={styles.offlineDot} />
              <Text style={styles.offlineBadgeText}>100% On-Device AI</Text>
            </View>
            {DEV_TOOLS_ENABLED && (
              <TouchableOpacity
                style={styles.benchmarkHeaderPill}
                onPress={() => setShowBenchmark(true)}
                accessibilityLabel="Open Benchmark Harness"
              >
                <Text style={styles.benchmarkHeaderPillText}>🔬 Benchmark</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Navigation Tabs (Journal vs Weekly Recap) */}
        <View style={styles.navTabs}>
          <TouchableOpacity
            style={[styles.navTab, activeTab === 'journal' && styles.navTabActive]}
            onPress={() => setActiveTab('journal')}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.navTabText,
                activeTab === 'journal' && styles.navTabTextActive,
              ]}
            >
              🎙️ Journal
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navTab, activeTab === 'recap' && styles.navTabActive]}
            onPress={() => setActiveTab('recap')}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.navTabText,
                activeTab === 'recap' && styles.navTabTextActive,
              ]}
            >
              📊 Recap
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navTab, activeTab === 'settings' && styles.navTabActive]}
            onPress={() => setActiveTab('settings')}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.navTabText,
                activeTab === 'settings' && styles.navTabTextActive,
              ]}
            >
              ⚙️ Settings
            </Text>
          </TouchableOpacity>
        </View>

        {/* Database Encryption Error Banner */}
        {dbError ? (
          <View style={styles.dbErrorBanner}>
            <Text style={styles.dbErrorTitle}>⚠️ Database Encryption Issue</Text>
            <Text style={styles.dbErrorText}>{dbError}</Text>
            <TouchableOpacity
              style={styles.dbResetButton}
              onPress={handleResetDatabase}
              activeOpacity={0.8}
            >
              <Text style={styles.dbResetButtonText}>Reset Database & Keys</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {activeTab === 'journal' ? (
          <>
            {/* Processing or Error Banners */}
            {processingStage ? (
              <View style={styles.processingBanner}>
                <Text style={styles.processingText}>⚡ {processingStage}</Text>
              </View>
            ) : null}

            {errorMessage ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{errorMessage}</Text>
              </View>
            ) : null}

            {/* Big Record Button & 60s Timer */}
            <View style={styles.recordSection}>
              {/* STT Language Mode Selector */}
              <View style={styles.sttModeSelector}>
                <TouchableOpacity
                  style={[
                    styles.sttModePill,
                    sttLanguage === 'hi' && styles.sttModePillActive,
                  ]}
                  onPress={() => setSttLanguage('hi')}
                  disabled={isBusy}
                  activeOpacity={0.7}
                  accessibilityLabel="Transcribe Hindi / Hinglish with Android's on-device recognizer"
                >
                  <Text
                    style={[
                      styles.sttModePillText,
                      sttLanguage === 'hi' && styles.sttModePillTextActive,
                    ]}
                  >
                    🇮🇳 Hindi / Hinglish
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.sttModePill,
                    sttLanguage === 'en' && styles.sttModePillActive,
                  ]}
                  onPress={() => setSttLanguage('en')}
                  disabled={isBusy}
                  activeOpacity={0.7}
                  accessibilityLabel="Transcribe English"
                >
                  <Text
                    style={[
                      styles.sttModePillText,
                      sttLanguage === 'en' && styles.sttModePillTextActive,
                    ]}
                  >
                    🇬🇧 English
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.sttEngineNote}>
                {sttLanguage === 'hi'
                  ? 'Engine: Android on-device recognizer (hi-IN). No cloud fallback.'
                  : `Engine: Whisper ${whisperVariant.engine === 'whisper_base_en' ? 'base.en' : 'small.en'}, on-device.`}
              </Text>

              {DEV_TOOLS_ENABLED && sttLanguage === 'en' ? (
                <View style={styles.devVariantBox}>
                  <Text style={styles.devVariantTitle}>
                    DEV: Whisper build (timing only){!stt.isReady ? ' · loading…' : ''}
                  </Text>
                  {WHISPER_VARIANTS.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => setWhisperVariantId(v.id)}
                      disabled={isBusy || Boolean(pendingReview)}
                      style={[
                        styles.devVariantRow,
                        whisperVariantId === v.id && styles.devVariantRowActive,
                      ]}
                    >
                      <Text style={styles.devVariantText}>
                        {whisperVariantId === v.id ? '● ' : '○ '}
                        {v.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  {stt.error ? (
                    <Text style={styles.devVariantError}>
                      Load failed: {stt.error.message}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {sttLanguage === 'hi' ? (
                <HindiPackGate
                  gate={hindi.gate}
                  isChecking={hindi.isCheckingGate}
                  installStatus={hindi.installStatus}
                  onInstall={hindi.installPack}
                  onRecheck={hindi.checkGate}
                  onOpenSettings={hindi.openSpeechSettings}
                />
              ) : null}

              {hindiGateBlocks && !isBusy ? null : (
                <RecordButton
                  status={recordingStatus}
                  elapsedSeconds={elapsedSeconds}
                  maxSeconds={MAX_RECORDING_SECONDS}
                  onPress={handleToggleRecord}
                />
              )}

              {sttLanguage === 'hi' && hindi.isListening && hindi.partialText ? (
                <Text style={styles.livePartialText}>
                  {/* Display only: same script conversion as the review draft. */}
                  {convertDevanagariToHinglish(hindi.partialText)}
                </Text>
              ) : null}
            </View>

            {/* Sub-stage 1B & 1C: Editable Transcript Review Card */}
            {pendingReview ? (
              <TranscriptReviewCard
                key={pendingReview.key}
                restored={pendingReview.restored}
                onDraftChange={handleDraftChange}
                rawTranscript={pendingReview.rawTranscript}
                initialTranscript={pendingReview.initialTranscript}
                sttEngine={pendingReview.sttEngine}
                audioLengthMs={pendingReview.audioLengthMs}
                sttMs={pendingReview.sttMs}
                isSaving={isSavingEntry}
                saveError={saveEntryError}
                suggestedTags={suggestedTags}
                isSuggestingTags={isSuggestingTags}
                onSave={handleSaveEntry}
                onDiscard={handleDiscardEntry}
              />
            ) : null}

            {/* Late Arrival AI Suggestions Banner */}
            {lateSuggestionPrompt && (
              <View style={styles.lateSuggestionCard}>
                <View style={styles.lateSuggestionHeader}>
                  <Text style={styles.lateSuggestionTitle}>
                    💡 Suggested tags for your latest saved note:
                  </Text>
                  <TouchableOpacity onPress={() => setLateSuggestionPrompt(null)}>
                    <Text style={styles.dismissLateText}>Dismiss</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.lateSuggestionPillsRow}>
                  {lateSuggestionPrompt.suggestedTags.map((tag) => (
                    <TouchableOpacity
                      key={tag}
                      style={styles.lateSuggestionPill}
                      onPress={() => handleAcceptLateTag(tag)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.lateSuggestionPillText}>+ #{tag}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Empty state when no past entries and not reviewing */}
            {!pendingReview && pastEntries.length === 0 ? (
              <View style={styles.emptyStateContainer}>
                <Text style={styles.emptyStateTitle}>Speak your thoughts</Text>
                <Text style={styles.emptyStateSubtitle}>
                  Tap the red button to record up to 60 seconds. Your speech is transcribed on the phone, offline.
                </Text>
              </View>
            ) : null}

            {/* Past Journal Entries List with Tap to Reopen and Edit */}
            <PastEntriesList
              entries={pastEntries}
              onUpdateEntry={handleUpdateEntry}
            />
          </>
        ) : (
          activeTab === 'recap' ? (
            <WeeklyRecapView
              entries={pastEntries}
              onRefreshEntries={loadPastEntries}
              isLlmReady={Boolean(llm.isReady)}
              runInsight={runInsight}
            />
          ) : (
            <SettingsScreen
              entries={pastEntries}
              englishEngineLabel={sttEngineLabel(whisperVariant.engine)}
              englishModelFile={sttModelConfig.modelPath.split('/').pop() ?? ''}
              isWhisperReady={Boolean(stt.isReady)}
              llmName={ACTIVE_LLM_CONFIG.displayName}
              isLlmReady={Boolean(llm.isReady)}
              hindiGate={hindi.gate}
              onRecheckHindi={hindi.checkGate}
              onDeleteAll={handleDeleteAll}
            />
          )
        )}
      </ScrollView>

      {/* Development-only Benchmark Harness Screen */}
      {DEV_TOOLS_ENABLED && (
        <BenchmarkRunnerScreen
          visible={showBenchmark}
          onClose={() => setShowBenchmark(false)}
          isSttReady={Boolean(stt.isReady)}
          transcribeEnglish={benchmarkTranscribeEnglish}
          englishEngine={whisperVariant.engine}
          englishModelPath={sttModelConfig.modelPath}
          isLlmReady={Boolean(llm.isReady)}
          llmName={ACTIVE_LLM_CONFIG.displayName}
          suggestTags={benchmarkSuggestTags}
          appBusy={isBusy || Boolean(pendingReview)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  scrollContent: {
    padding: 20,
    alignItems: 'center',
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingTop: 10,
  },
  brandTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: -0.5,
  },
  navTabs: {
    flexDirection: 'row',
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  navTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  navTabActive: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  navTabText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
  },
  navTabTextActive: {
    color: '#F8FAFC',
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  benchmarkHeaderPill: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  benchmarkHeaderPillText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
  },
  offlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderColor: 'rgba(34, 197, 94, 0.25)',
    borderWidth: 1,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
  },
  offlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22C55E',
    marginRight: 6,
  },
  offlineBadgeText: {
    fontSize: 12,
    color: '#4ADE80',
    fontWeight: '600',
  },
  processingBanner: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderColor: 'rgba(99, 102, 241, 0.3)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    width: '100%',
    marginBottom: 16,
  },
  processingText: {
    color: '#C7D2FE',
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    width: '100%',
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#FCA5A5',
    fontSize: 13,
    textAlign: 'center',
  },
  dbErrorBanner: {
    width: '100%',
    backgroundColor: '#7F1D1D',
    borderWidth: 1,
    borderColor: '#EF4444',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  dbErrorTitle: {
    color: '#FECACA',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  dbErrorText: {
    color: '#FCA5A5',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  dbResetButton: {
    backgroundColor: '#DC2626',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  dbResetButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  recordSection: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 20,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  sttModeSelector: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 14,
  },
  sttModePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
  },
  sttModePillActive: {
    backgroundColor: '#1E3A5F',
    borderColor: '#38BDF8',
  },
  sttModePillText: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: '600',
  },
  devVariantBox: {
    borderWidth: 1,
    borderColor: '#A855F7',
    borderStyle: 'dashed',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  devVariantTitle: { color: '#D8B4FE', fontSize: 11, fontWeight: '700', marginBottom: 6 },
  devVariantRow: { paddingVertical: 5, paddingHorizontal: 6, borderRadius: 6 },
  devVariantRowActive: { backgroundColor: 'rgba(168, 85, 247, 0.18)' },
  devVariantText: { color: '#E2E8F0', fontSize: 12 },
  devVariantError: { color: '#FCA5A5', fontSize: 11, marginTop: 6 },
  sttEngineNote: {
    color: '#94A3B8',
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 12,
  },
  livePartialText: {
    color: '#CBD5E1',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 8,
  },
  sttModePillTextActive: {
    color: '#38BDF8',
    fontWeight: '700',
  },
  resultsContainer: {
    width: '100%',
  },
  emptyStateContainer: {
    paddingVertical: 36,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#94A3B8',
    marginBottom: 8,
  },
  emptyStateSubtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  lateSuggestionCard: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  lateSuggestionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lateSuggestionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  dismissLateText: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '600',
  },
  lateSuggestionPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  lateSuggestionPill: {
    backgroundColor: '#0F172A',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#0284C7',
  },
  lateSuggestionPillText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
});
