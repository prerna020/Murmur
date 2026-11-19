import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  ScrollView,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  type WhisperLanguage,
  type WhisperSttModel,
  setTelemetryEnabled,
  models,
  useSpeechToText,
  useLLMChatSession,
} from 'react-native-executorch';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  useAudioStream,
  setAudioModeAsync,
} from 'expo-audio';

import { PermissionState, RecordingStatus } from './src/types/stt';
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
  DatabaseEncryptionError,
} from './src/services/database';
import {
  cleanupOrphanedAudioFiles,
  deleteAudioFileSilently,
} from './src/services/audioCleanup';
import { suggestTopicTags } from './src/services/tagSuggestion';
import { ACTIVE_LLM_CONFIG, STT_BENCHMARK_LANGUAGE } from './src/config/modelConfig';
import { BenchmarkScreen } from './src/screens/BenchmarkScreen';
import { WeeklyRecapView } from './src/components/WeeklyRecapView';
import { convertDevanagariToHinglish } from './src/services/hinglishTransliteration';

// Opt out of anonymous download telemetry immediately — 100% private
setTelemetryEnabled(false);

const MAX_RECORDING_SECONDS = 60;
const SAMPLE_RATE = 16000;

export default function App() {
  // Permission state
  const [permissionState, setPermissionState] = useState<PermissionState>('checking');

  // Retry key to force model reloading if needed
  const [modelReloadKey, setModelReloadKey] = useState(0);

  // Speech-to-Text active language. English uses the English-only Whisper model
  // (more accurate on English); Hindi/Hinglish uses the multilingual model.
  const [sttLanguage, setSttLanguage] = useState<'hi' | 'en'>(STT_BENCHMARK_LANGUAGE);

  // 1. Whisper STT model hook (Speech-to-Text). Only one model is held in memory:
  // changing the language tab unloads the old model and loads the other one.
  const sttModelConfig: WhisperSttModel<WhisperLanguage> =
    sttLanguage === 'en'
      ? models.speechToText.WHISPER.EN.SMALL.DEFAULT
      : // Hindi uses the full-precision (FP32) multilingual model. The default INT8
        // build is quantized and loses a lot of accuracy on non-English speech,
        // which shows up as random/garbled Hindi words. Larger download (~1 GB).
        models.speechToText.WHISPER.SMALL.XNNPACK_FP32;
  const stt = useSpeechToText<WhisperLanguage>(sttModelConfig);

  // The full-screen download gate is only for first launch; later model swaps
  // (tab switch) keep the main screen visible.
  const hasLoadedModelsRef = useRef(false);

  // 2. Active on-device LLM model hook (Structured Extraction)
  const llm = useLLMChatSession(ACTIVE_LLM_CONFIG.source, { resetOnTurn: true });

  // Benchmark modal visibility (accessible only in __DEV__)
  const [showBenchmark, setShowBenchmark] = useState(false);

  // Recording & processing states
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [processingStage, setProcessingStage] = useState<string>('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sub-stage 2A: Navigation tab ('journal' | 'recap')
  const [activeTab, setActiveTab] = useState<'journal' | 'recap'>('journal');

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
    rawTranscript: string;
    initialTranscript: string;
    audioLengthMs: number;
    sttMs: number;
    tempAudioUri: string | null;
  }
  const [pendingReview, setPendingReview] = useState<PendingReviewData | null>(null);
  const [isSavingEntry, setIsSavingEntry] = useState<boolean>(false);
  const [saveEntryError, setSaveEntryError] = useState<string | null>(null);

  // Sub-stage 1C: Mood & Tag suggestion state
  const [suggestedTags, setSuggestedTags] = useState<TopicType[]>([]);
  const [isSuggestingTags, setIsSuggestingTags] = useState<boolean>(false);
  const tagSuggestionMetaRef = useRef<{
    status: TagStatus;
    llmMs: number;
    retryCount: number;
  }>({
    status: 'none',
    llmMs: 0,
    retryCount: 0,
  });
  const lastSavedEntryIdRef = useRef<string | null>(null);
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
      // Clean up orphaned audio files from previous crashes/closes
      cleanupOrphanedAudioFiles(null);

      // Initialize Encrypted Database and load past entries
      await loadPastEntries();

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
    const createdAt = Date.now();

    const currentMeta = tagSuggestionMetaRef.current;
    const finalTagStatus: TagStatus =
      currentMeta.status !== 'none'
        ? currentMeta.status
        : tags.length > 0
        ? 'ok'
        : 'none';

    const journalEntry: JournalEntry = {
      id: entryId,
      createdAt,
      updatedAt: createdAt,
      rawTranscript: pendingReview.rawTranscript, // untouched Whisper STT output
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
      lastSavedEntryIdRef.current = entryId;
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
    lastSavedEntryIdRef.current = null;
    recordedFileUriRef.current = null;
  };

  const handleAcceptLateTag = async (tag: string) => {
    if (!lateSuggestionPrompt) return;
    const entry = pastEntries.find((e) => e.id === lateSuggestionPrompt.entryId);
    if (entry && !entry.tags.includes(tag)) {
      const updatedTags = [...entry.tags, tag];
      await updateJournalEntryMetadata(
        entry.id,
        entry.moodSelection,
        updatedTags,
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

  // Reusable LLM call shared between live journal extraction and benchmark harness
  const sendLLM = useCallback(
    async (prompt: string): Promise<string> => {
      if (!llm.sendMessage) {
        throw new Error('LLM session is not ready');
      }
      let streamed = '';
      const turn = await llm.sendMessage(prompt, (token) => {
        streamed += token;
      });

      const assistantMsg = turn.messages.find((m) => m.role === 'assistant');
      const fallbackMsg = typeof assistantMsg?.content === 'string' ? assistantMsg.content : '';
      const rawMsg = streamed || fallbackMsg;
      // Strip reasoning tokens from deepseek/qwen reasoning variants to prevent internal leakage
      return rawMsg
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .trim();
    },
    [llm]
  );

  // Stop recording and run the two-stage AI pipeline: STT then LLM Extraction
  const stopRecordingAndProcess = useCallback(async () => {
    if (recordingStatus !== 'recording') return;

    // Clear timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    setRecordingStatus('transcribing');
    setProcessingStage('Transcribing audio on-device (Whisper)...');
    setErrorMessage(null);

    let recordedUri: string | null = null;
    try {
      // Finalize audio file recording
      const fileResult = await stream.stopFileRecordingAsync().catch(() => null);
      if (fileResult?.uri) {
        recordedUri = fileResult.uri;
        recordedFileUriRef.current = fileResult.uri;
      }
      stream.stop();
    } catch {
      // Continue even if file stop fails, we have raw PCM chunks
    }

    try {
      // Combine Float32Array chunks
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
      const mergeMs = Math.round(performance.now() - mergeStart);

      if (!stt.transcribe) {
        throw new Error('Whisper transcriber is not initialized');
      }

      // 1. On-Device Speech-to-Text
      const audioLengthMs = Math.round((totalSamples / SAMPLE_RATE) * 1000);
      const sttStart = performance.now();
      // Token arrival times, used only for the timing log below (no text is logged).
      const tokenTimes: number[] = [];
      const transcribedText = await stt.transcribe(
        mergedAudio,
        { language: sttLanguage },
        () => {
          tokenTimes.push(performance.now());
        }
      );
      const sttEnd = performance.now();
      const sttMs = Math.round(sttEnd - sttStart);

      // Timing split. Whisper processes audio in 29 s windows, and each window
      // runs the encoder once before decoding tokens. The encoder is not
      // instrumented inside the library, so its time shows up as the delay before
      // the first token and as the biggest gap between tokens (second window).
      const firstTokenMs = tokenTimes.length ? Math.round(tokenTimes[0] - sttStart) : null;
      let maxGapMs = 0;
      for (let i = 1; i < tokenTimes.length; i++) {
        maxGapMs = Math.max(maxGapMs, Math.round(tokenTimes[i] - tokenTimes[i - 1]));
      }
      const windows = Math.ceil(totalSamples / (29 * SAMPLE_RATE));
      console.log(
        '[STT-TIMING] ' +
          JSON.stringify({
            build: __DEV__ ? 'debug-js' : 'release-js',
            language: sttLanguage,
            modelPath: sttModelConfig.modelPath,
            audioMs: audioLengthMs,
            pcmMergeMs: mergeMs,
            windows,
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
        deleteAudioFileSilently(recordedUri);
        return;
      }

      // If transcribed in Hindi mode or contains Devanagari script, convert immediately to natural Roman-script Hinglish
      const reviewTranscript = convertDevanagariToHinglish(transcribedText);

      // Sub-stage 1B: Show the transcript in an editable review card.
      // Order of operations: Keep recordedUri intact on disk until save is confirmed!
      setPendingReview({
        rawTranscript: transcribedText,
        initialTranscript: reviewTranscript,
        audioLengthMs,
        sttMs,
        tempAudioUri: recordedUri,
      });

      setRecordingStatus('idle');
      setProcessingStage('');
      setSaveEntryError(null);

      // Sub-stage 1C: Trigger on-device model tag suggestion in background (non-blocking)
      setIsSuggestingTags(true);
      setSuggestedTags([]);
      lastSavedEntryIdRef.current = null;
      tagSuggestionMetaRef.current = { status: 'none', llmMs: 0, retryCount: 0 };

      suggestTopicTags(reviewTranscript, sendLLM)
        .then((result) => {
          tagSuggestionMetaRef.current = {
            status: result.status,
            llmMs: result.llmMs,
            retryCount: result.retryCount,
          };
          setSuggestedTags(result.tags);

          // If entry was already saved while suggestions were generating:
          if (lastSavedEntryIdRef.current && result.tags.length > 0) {
            setLateSuggestionPrompt({
              entryId: lastSavedEntryIdRef.current,
              suggestedTags: result.tags,
            });
          }
        })
        .catch(() => {
          tagSuggestionMetaRef.current = {
            status: 'failed',
            llmMs: 0,
            retryCount: 1,
          };
          setSuggestedTags([]);
        })
        .finally(() => {
          setIsSuggestingTags(false);
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Processing failed';
      setErrorMessage(msg);
      setRecordingStatus('error');
      setProcessingStage('');
      deleteAudioFileSilently(recordedUri);
    }
  }, [recordingStatus, stream, stt, sendLLM, sttLanguage, sttModelConfig.modelPath]);

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

      // 60-second timer
      const startTime = Date.now();
      timerIntervalRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        setElapsedSeconds(seconds);

        if (seconds >= MAX_RECORDING_SECONDS) {
          stopRecordingAndProcess();
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
    if (!stt.isReady) {
      Alert.alert(
        'Speech model loading',
        'The speech model is still loading for this language. Please wait a moment.'
      );
      return;
    }
    if (recordingStatus === 'idle' || recordingStatus === 'error') {
      startRecording();
    } else if (recordingStatus === 'recording') {
      stopRecordingAndProcess();
    }
  };

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
            {__DEV__ && (
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
              📊 Weekly Recap
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
                  disabled={recordingStatus === 'recording' || !stt.isReady}
                  activeOpacity={0.7}
                  accessibilityLabel="Transcribe Hindi / Hinglish"
                >
                  <Text
                    style={[
                      styles.sttModePillText,
                      sttLanguage === 'hi' && styles.sttModePillTextActive,
                    ]}
                  >
                    🇮🇳 Hindi (experimental)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.sttModePill,
                    sttLanguage === 'en' && styles.sttModePillActive,
                  ]}
                  onPress={() => setSttLanguage('en')}
                  disabled={recordingStatus === 'recording' || !stt.isReady}
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

              <RecordButton
                status={recordingStatus}
                elapsedSeconds={elapsedSeconds}
                maxSeconds={MAX_RECORDING_SECONDS}
                onPress={handleToggleRecord}
              />
            </View>

            {/* Sub-stage 1B & 1C: Editable Transcript Review Card */}
            {pendingReview ? (
              <TranscriptReviewCard
                rawTranscript={pendingReview.rawTranscript}
                initialTranscript={pendingReview.initialTranscript}
                audioLengthMs={pendingReview.audioLengthMs}
                sttMs={pendingReview.sttMs}
                isSaving={isSavingEntry}
                saveError={saveEntryError}
                suggestedTags={suggestedTags}
                isSuggestingTags={isSuggestingTags}
                onSave={handleSaveEntry}
                onDiscard={handleDiscardEntry}
                onRetrySave={() =>
                  handleSaveEntry(pendingReview.initialTranscript, null, [])
                }
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
                  Tap the red button to record up to 60 seconds. Whisper will transcribe your speech completely offline.
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
          /* Sub-stage 2A: Weekly Recap Screen */
          <WeeklyRecapView
            entries={pastEntries}
            onRefreshEntries={loadPastEntries}
          />
        )}
      </ScrollView>

      {/* Development-only Benchmark Harness Screen */}
      {__DEV__ && (
        <BenchmarkScreen
          visible={showBenchmark}
          onClose={() => setShowBenchmark(false)}
          sendLLMMessage={sendLLM}
          isLlmReady={Boolean(llm.isReady)}
          transcribeAudio={stt.transcribe}
          isSttReady={Boolean(stt.isReady)}
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
