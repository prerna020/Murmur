import React, { useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Modal,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Platform,
  Alert,
  Share,
} from 'react-native';
import { File, Directory, Paths } from 'expo-file-system';
// LEGACY: this screen is no longer used by the app (replaced by
// BenchmarkRunnerScreen). benchmark/audio/ was removed, so its old STT
// reference list is empty here. Safe to delete this file.
import datasetRaw from '../../benchmark/dataset.json';
import { ACTIVE_LLM_CONFIG } from '../config/modelConfig';
import type { SttEngine } from '../types/stt';
import {
  BenchmarkDatasetItem,
  BenchmarkEntryResult,
  BenchmarkResultsPayload,
  SttReferenceItem,
  SttBenchmarkEntryResult,
  SttBenchmarkResultsPayload,
} from '../types/benchmark';
import { runReliabilityPipeline } from '../services/extraction';
import { extractWithFallback } from '../services/fallback';
import { decodeWavBytes } from '../utils/wavDecoder';
import { computeWordErrorRate } from '../utils/wer';

const sttReferencesRaw: unknown[] = [];
const dataset = datasetRaw as BenchmarkDatasetItem[];
const sttReferences = sttReferencesRaw as SttReferenceItem[];

/** The only STT engine this screen runs today. */
const WHISPER_ENGINE: SttEngine = 'whisper_small_en';

type BenchmarkTab = 'llm' | 'stt';

interface BenchmarkScreenProps {
  visible: boolean;
  onClose: () => void;
  sendLLMMessage: (prompt: string) => Promise<string>;
  isLlmReady: boolean;
  transcribeAudio?: (audio: Float32Array, options: { language: 'en' }) => Promise<string>;
  isSttReady?: boolean;
}

export function BenchmarkScreen({
  visible,
  onClose,
  sendLLMMessage,
  isLlmReady,
  transcribeAudio,
  isSttReady = false,
}: BenchmarkScreenProps) {
  const [activeTab, setActiveTab] = useState<BenchmarkTab>('llm');

  // --- LLM Benchmark State ---
  const [isRunning, setIsRunning] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completedResults, setCompletedResults] = useState<BenchmarkEntryResult[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('Ready to start LLM benchmark');
  const [savedFilePath, setSavedFilePath] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // --- STT Benchmark State ---
  const [isSttRunning, setIsSttRunning] = useState(false);
  const [sttCurrentIndex, setSttCurrentIndex] = useState(0);
  const [sttCompletedResults, setSttCompletedResults] = useState<SttBenchmarkEntryResult[]>([]);
  const [sttStatusMessage, setSttStatusMessage] = useState<string>('Ready to test STT audio clips');
  const [sttSavedFilePath, setSttSavedFilePath] = useState<string | null>(null);
  const sttCancelledRef = useRef(false);

  // Device metadata
  const getDeviceInfo = () => {
    if (Platform.OS === 'android') {
      const constants = Platform.constants as unknown as {
        Brand?: string;
        Manufacturer?: string;
        Model?: string;
        Release?: string;
      };
      return {
        brand: constants.Brand ?? constants.Manufacturer ?? 'Android',
        model: constants.Model ?? 'Device',
        androidVersion: constants.Release ?? String(Platform.Version),
        platform: 'android',
      };
    }
    return {
      brand: 'Apple',
      model: 'iOS Device',
      androidVersion: String(Platform.Version),
      platform: Platform.OS,
    };
  };

  // ==========================================
  // LLM EXTRACTION RUNNER
  // ==========================================
  const handleStartBenchmark = async () => {
    if (!isLlmReady) {
      Alert.alert('Model Not Ready', 'Please wait for the on-device LLM model to finish loading.');
      return;
    }

    setIsRunning(true);
    cancelledRef.current = false;
    setCurrentIndex(0);
    setCompletedResults([]);
    setSavedFilePath(null);
    setStatusMessage('Running benchmark on 50 dataset entries...');

    const accumulated: BenchmarkEntryResult[] = [];

    for (let i = 0; i < dataset.length; i++) {
      if (cancelledRef.current) {
        setStatusMessage(`Benchmark cancelled after ${accumulated.length} entries.`);
        break;
      }

      const item = dataset[i];
      setCurrentIndex(i + 1);
      setStatusMessage(`Analyzing entry ${i + 1}/${dataset.length} (${item.id} - ${item.language})...`);

      try {
        const pipelineResult = await runReliabilityPipeline(item.text, sendLLMMessage);
        const fallbackBaseline = extractWithFallback(item.text);

        const entryResult: BenchmarkEntryResult = {
          id: item.id,
          language: item.language,
          groundTruth: {
            mood: item.mood,
            topics: item.topics,
          },
          pipelineResult: {
            predictedMood: pipelineResult.data.mood,
            predictedTopics: pipelineResult.data.topics,
            summary: pipelineResult.data.summary,
            path: pipelineResult.path,
            llmLatencyMs: pipelineResult.llmTimeMs,
            retryCount: pipelineResult.retries,
            firstAttemptValid: pipelineResult.firstAttemptValid,
          },
          fallbackBaseline: {
            predictedMood: fallbackBaseline.mood,
            predictedTopics: fallbackBaseline.topics,
            summary: fallbackBaseline.summary,
          },
        };

        accumulated.push(entryResult);
        setCompletedResults([...accumulated]);

        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        setStatusMessage(`Error on entry ${item.id}: ${errorMsg}. Continuing...`);
      }
    }

    const wasCancelled = cancelledRef.current;
    setIsRunning(false);

    try {
      const payload: BenchmarkResultsPayload = {
        timestamp: new Date().toISOString(),
        modelName: ACTIVE_LLM_CONFIG.displayName,
        modelId: ACTIVE_LLM_CONFIG.id,
        languageConfig: 'en',
        device: getDeviceInfo(),
        totalEntries: dataset.length,
        completedEntries: accumulated.length,
        cancelled: wasCancelled,
        results: accumulated,
      };

      const jsonString = JSON.stringify(payload, null, 2);
      const resultsFile = new File(Paths.document, 'benchmark_results.json');
      if (resultsFile.exists) {
        resultsFile.delete();
      }
      resultsFile.create({ overwrite: true });
      await resultsFile.write(jsonString);

      setSavedFilePath(resultsFile.uri);
      setStatusMessage(
        wasCancelled
          ? `Benchmark stopped. Saved ${accumulated.length} results to disk.`
          : `Benchmark completed! All ${accumulated.length} entries saved to disk.`
      );
    } catch (saveErr: unknown) {
      const saveMsg = saveErr instanceof Error ? saveErr.message : 'Failed to save file';
      Alert.alert('Save Error', `Could not save results: ${saveMsg}`);
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setStatusMessage('Cancelling... finishing current entry.');
  };

  const handleShare = async () => {
    if (!savedFilePath) {
      Alert.alert('No Results', 'Run the benchmark first to generate results.');
      return;
    }
    try {
      const resultsFile = new File(Paths.document, 'benchmark_results.json');
      const text = await resultsFile.text();
      await Share.share({
        title: 'Murmur Benchmark Results',
        message: text,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sharing failed';
      Alert.alert('Share Error', msg);
    }
  };

  // ==========================================
  // STT SPEECH-TO-TEXT RUNNER (Phase 3C)
  // ==========================================
  const handleStartSttBenchmark = async () => {
    if (!isSttReady || !transcribeAudio) {
      Alert.alert('STT Not Ready', 'Whisper STT model is not ready yet. Please wait for download/initialization.');
      return;
    }

    setIsSttRunning(true);
    sttCancelledRef.current = false;
    setSttCurrentIndex(0);
    setSttCompletedResults([]);
    setSttSavedFilePath(null);
    setSttStatusMessage(`Running STT benchmark (${WHISPER_ENGINE}, English clips only)...`);

    const accumulated: SttBenchmarkEntryResult[] = [];
    const benchmarkAudioDir = new Directory(Paths.document, 'benchmark_audio');
    if (!benchmarkAudioDir.exists) {
      benchmarkAudioDir.create({ intermediates: true });
    }

    for (let i = 0; i < sttReferences.length; i++) {
      if (sttCancelledRef.current) {
        setSttStatusMessage(`STT Benchmark cancelled after ${accumulated.length} clips.`);
        break;
      }

      const item = sttReferences[i];
      setSttCurrentIndex(i + 1);
      setSttStatusMessage(`Checking clip ${i + 1}/${sttReferences.length}: ${item.fileName}...`);

      // Hinglish uses Android's on-device recognizer in the app, not Whisper.
      // Running Whisper small.en on these clips would measure the wrong engine,
      // so they stay "not measured" until the file-input runner exists (Phase 5).
      if (item.language === 'hinglish') {
        accumulated.push({
          id: item.id,
          fileName: item.fileName,
          language: item.language,
          sttEngine: 'android_ondevice_hi',
          referenceTranscript: item.referenceTranscript,
          hypothesisTranscript: null,
          status: 'not_measured',
          wer: null,
          substitutions: null,
          deletions: null,
          insertions: null,
          transcriptionTimeMs: null,
          audioDurationMs: null,
          errorMessage: 'Hinglish clips use android_ondevice_hi; its benchmark runner is not built yet',
        });
        setSttCompletedResults([...accumulated]);
        continue;
      }

      const clipFile = new File(benchmarkAudioDir, item.fileName);

      // Verify file existence and non-zero size
      if (!clipFile.exists || clipFile.size < 44) {
        // Audio clip is empty or not yet recorded
        accumulated.push({
          id: item.id,
          fileName: item.fileName,
          language: item.language,
          sttEngine: WHISPER_ENGINE,
          referenceTranscript: item.referenceTranscript,
          hypothesisTranscript: null,
          status: 'not_measured',
          wer: null,
          substitutions: null,
          deletions: null,
          insertions: null,
          transcriptionTimeMs: null,
          audioDurationMs: null,
          errorMessage: 'Audio clip not recorded yet',
        });
        setSttCompletedResults([...accumulated]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }

      try {
        setSttStatusMessage(`Transcribing ${item.fileName} with ${WHISPER_ENGINE}...`);
        const buffer = await clipFile.arrayBuffer();
        const decoded = decodeWavBytes(new Uint8Array(buffer));

        if (decoded.samples.length === 0) {
          accumulated.push({
            id: item.id,
            fileName: item.fileName,
            language: item.language,
            sttEngine: WHISPER_ENGINE,
            referenceTranscript: item.referenceTranscript,
            hypothesisTranscript: null,
            status: 'not_measured',
            wer: null,
            substitutions: null,
            deletions: null,
            insertions: null,
            transcriptionTimeMs: null,
            audioDurationMs: null,
            errorMessage: 'Empty WAV data (0 samples)',
          });
        } else {
          const startTime = performance.now();
          const hypothesis = await transcribeAudio(decoded.samples, { language: 'en' });
          const latencyMs = Math.round(performance.now() - startTime);

          const werResult = computeWordErrorRate(item.referenceTranscript, hypothesis);

          accumulated.push({
            id: item.id,
            fileName: item.fileName,
            language: item.language,
            sttEngine: WHISPER_ENGINE,
            referenceTranscript: item.referenceTranscript,
            hypothesisTranscript: hypothesis,
            status: 'completed',
            wer: werResult.wer,
            substitutions: werResult.substitutions,
            deletions: werResult.deletions,
            insertions: werResult.insertions,
            transcriptionTimeMs: latencyMs,
            audioDurationMs: decoded.durationMs,
          });
        }

        setSttCompletedResults([...accumulated]);
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch (clipErr: unknown) {
        const errorMsg = clipErr instanceof Error ? clipErr.message : 'Transcription failed';
        accumulated.push({
          id: item.id,
          fileName: item.fileName,
          language: item.language,
          sttEngine: WHISPER_ENGINE,
          referenceTranscript: item.referenceTranscript,
          hypothesisTranscript: null,
          status: 'error',
          wer: null,
          substitutions: null,
          deletions: null,
          insertions: null,
          transcriptionTimeMs: null,
          audioDurationMs: null,
          errorMessage: errorMsg,
        });
        setSttCompletedResults([...accumulated]);
      }
    }

    const wasCancelled = sttCancelledRef.current;
    setIsSttRunning(false);

    // Compute aggregate metrics
    const measuredList = accumulated.filter((r) => r.status === 'completed' && r.wer !== null);
    const avgWer =
      measuredList.length > 0
        ? Number(
            (
              measuredList.reduce((acc, r) => acc + (r.wer ?? 0), 0) / measuredList.length
            ).toFixed(4)
          )
        : null;
    const avgLatency =
      measuredList.length > 0
        ? Math.round(
            measuredList.reduce((acc, r) => acc + (r.transcriptionTimeMs ?? 0), 0) /
              measuredList.length
          )
        : null;

    // Save STT results payload
    try {
      const payload: SttBenchmarkResultsPayload = {
        timestamp: new Date().toISOString(),
        modelName: 'Whisper small.en',
        sttEngine: WHISPER_ENGINE,
        languageSetting: 'en',
        device: getDeviceInfo(),
        totalClips: sttReferences.length,
        measuredClips: measuredList.length,
        averageWer: avgWer,
        averageTranscriptionTimeMs: avgLatency,
        results: accumulated,
      };

      const jsonString = JSON.stringify(payload, null, 2);
      const sttResultsFile = new File(Paths.document, 'stt_benchmark_results.json');
      if (sttResultsFile.exists) {
        sttResultsFile.delete();
      }
      sttResultsFile.create({ overwrite: true });
      await sttResultsFile.write(jsonString);

      setSttSavedFilePath(sttResultsFile.uri);
      setSttStatusMessage(
        wasCancelled
          ? `STT Benchmark cancelled. Saved ${accumulated.length} clip results to disk.`
          : `STT Benchmark finished. ${measuredList.length}/${sttReferences.length} clips measured.`
      );
    } catch (saveErr: unknown) {
      const saveMsg = saveErr instanceof Error ? saveErr.message : 'Failed to save STT file';
      Alert.alert('Save Error', `Could not save STT results: ${saveMsg}`);
    }
  };

  const handleCancelStt = () => {
    sttCancelledRef.current = true;
    setSttStatusMessage('Cancelling STT benchmark...');
  };

  const handleShareStt = async () => {
    if (!sttSavedFilePath) {
      Alert.alert('No Results', 'Run the STT benchmark first to generate results.');
      return;
    }
    try {
      const resultsFile = new File(Paths.document, 'stt_benchmark_results.json');
      const text = await resultsFile.text();
      await Share.share({
        title: 'Murmur STT Benchmark Results',
        message: text,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sharing failed';
      Alert.alert('Share Error', msg);
    }
  };

  // --- LLM Metrics ---
  const progressPercent = Math.round((currentIndex / dataset.length) * 100);
  const totalCompleted = completedResults.length;
  const firstAttemptValidCount = completedResults.filter(
    (r) => r.pipelineResult.firstAttemptValid
  ).length;
  const retryCount = completedResults.filter(
    (r) => r.pipelineResult.path === 'llm_retry'
  ).length;
  const fallbackCount = completedResults.filter(
    (r) => r.pipelineResult.path === 'fallback'
  ).length;
  const avgLatency =
    totalCompleted > 0
      ? Math.round(
          completedResults.reduce((acc, r) => acc + r.pipelineResult.llmLatencyMs, 0) /
            totalCompleted
        )
      : 0;

  // --- STT Metrics ---
  const sttProgressPercent = Math.round((sttCurrentIndex / sttReferences.length) * 100);
  const sttMeasuredCount = sttCompletedResults.filter((r) => r.status === 'completed').length;
  const sttNotMeasuredCount = sttCompletedResults.filter((r) => r.status === 'not_measured').length;
  const sttMeasuredList = sttCompletedResults.filter(
    (r) => r.status === 'completed' && r.wer !== null
  );
  const sttAvgWer =
    sttMeasuredList.length > 0
      ? (
          (sttMeasuredList.reduce((acc, r) => acc + (r.wer ?? 0), 0) /
            sttMeasuredList.length) *
          100
        ).toFixed(1) + '%'
      : 'not measured';
  const sttAvgLatency =
    sttMeasuredList.length > 0
      ? Math.round(
          sttMeasuredList.reduce((acc, r) => acc + (r.transcriptionTimeMs ?? 0), 0) /
            sttMeasuredList.length
        ) + ' ms'
      : 'not measured';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>🔬 Benchmark Harness</Text>
            <Text style={styles.headerSubtitle}>
              {activeTab === 'llm'
                ? `Model: ${ACTIVE_LLM_CONFIG.displayName}`
                : `STT: ${WHISPER_ENGINE}`}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.closeButton, (isRunning || isSttRunning) && styles.buttonDisabled]}
            onPress={onClose}
            disabled={isRunning || isSttRunning}
          >
            <Text style={styles.closeButtonText}>Done</Text>
          </TouchableOpacity>
        </View>

        {/* Mode Selector Tabs (Phase 3B / Phase 3C) */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'llm' && styles.tabButtonActive]}
            onPress={() => setActiveTab('llm')}
            disabled={isRunning || isSttRunning}
          >
            <Text style={[styles.tabText, activeTab === 'llm' && styles.tabTextActive]}>
              🧠 LLM Extraction (50)
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'stt' && styles.tabButtonActive]}
            onPress={() => setActiveTab('stt')}
            disabled={isRunning || isSttRunning}
          >
            <Text style={[styles.tabText, activeTab === 'stt' && styles.tabTextActive]}>
              🎙️ STT Audio (10)
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
          {/* ======================================================== */}
          {/* TAB 1: LLM STRUCTURED EXTRACTION BENCHMARK               */}
          {/* ======================================================== */}
          {activeTab === 'llm' && (
            <>
              {/* Config Summary Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Configuration</Text>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>LLM Model:</Text>
                  <Text style={styles.configValue}>{ACTIVE_LLM_CONFIG.displayName}</Text>
                </View>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Dataset:</Text>
                  <Text style={styles.configValue}>{dataset.length} items (25 En, 25 Hinglish)</Text>
                </View>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>LLM Status:</Text>
                  <Text
                    style={[
                      styles.configValue,
                      { color: isLlmReady ? '#4ade80' : '#f87171' },
                    ]}
                  >
                    {isLlmReady ? 'Loaded & Ready' : 'Loading Model...'}
                  </Text>
                </View>
              </View>

              {/* Progress & Controls */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Runner Status</Text>
                <Text style={styles.statusText}>{statusMessage}</Text>

                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${progressPercent}%` },
                    ]}
                  />
                </View>
                <Text style={styles.progressCounter}>
                  {currentIndex} / {dataset.length} ({progressPercent}%)
                </Text>

                <View style={styles.actionRow}>
                  {!isRunning ? (
                    <TouchableOpacity
                      style={[
                        styles.primaryButton,
                        !isLlmReady && styles.buttonDisabled,
                      ]}
                      onPress={handleStartBenchmark}
                      disabled={!isLlmReady}
                    >
                      <Text style={styles.primaryButtonText}>
                        {completedResults.length > 0
                          ? 'Rerun LLM Benchmark'
                          : 'Start Benchmark (50 Entries)'}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.cancelButton}
                      onPress={handleCancel}
                    >
                      <Text style={styles.cancelButtonText}>Cancel Benchmark</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Live Summary Statistics */}
              {totalCompleted > 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Live Run Statistics</Text>
                  <View style={styles.statsGrid}>
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Completed</Text>
                      <Text style={styles.statValue}>{totalCompleted}</Text>
                    </View>
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Valid 1st Try</Text>
                      <Text style={[styles.statValue, { color: '#4ade80' }]}>
                        {firstAttemptValidCount} (
                        {Math.round((firstAttemptValidCount / totalCompleted) * 100)}%)
                      </Text>
                    </View>
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Retried</Text>
                      <Text style={[styles.statValue, { color: '#fbbf24' }]}>
                        {retryCount}
                      </Text>
                    </View>
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Fallback</Text>
                      <Text style={[styles.statValue, { color: '#f87171' }]}>
                        {fallbackCount}
                      </Text>
                    </View>
                    <View style={[styles.statBox, { width: '100%', marginTop: 8 }]}>
                      <Text style={styles.statLabel}>Average LLM Latency</Text>
                      <Text style={styles.statValue}>{avgLatency} ms</Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Export / Off-device Transfer */}
              {savedFilePath && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Export Results</Text>
                  <Text style={styles.exportDesc}>
                    Results are saved to app storage. You can share the JSON directly or pull it via ADB:
                  </Text>

                  <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
                    <Text style={styles.shareButtonText}>📤 Share Results JSON</Text>
                  </TouchableOpacity>

                  <Text style={styles.codeHeader}>PowerShell adb command:</Text>
                  <View style={styles.codeBox}>
                    <Text selectable style={styles.codeText}>
                      adb exec-out run-as com.murmur.app cat files/benchmark_results.json &gt; benchmark/results_device.json
                    </Text>
                  </View>
                </View>
              )}

              {/* Entry-by-entry Log */}
              {totalCompleted > 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Completed Entries ({completedResults.length})</Text>
                  {completedResults.map((r) => {
                    const isMatch = r.pipelineResult.predictedMood === r.groundTruth.mood;
                    return (
                      <View key={r.id} style={styles.entryRow}>
                        <View style={styles.entryHeader}>
                          <Text style={styles.entryId}>
                            {r.id} [{r.language}]
                          </Text>
                          <View
                            style={[
                              styles.pathBadge,
                              r.pipelineResult.path === 'llm' && styles.pathBadgeLlm,
                              r.pipelineResult.path === 'llm_retry' && styles.pathBadgeRetry,
                              r.pipelineResult.path === 'fallback' && styles.pathBadgeFallback,
                            ]}
                          >
                            <Text style={styles.pathBadgeText}>
                              {r.pipelineResult.path.toUpperCase()} ({r.pipelineResult.llmLatencyMs}ms)
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.entryDetails}>
                          Mood: Pred{' '}
                          <Text style={{ color: isMatch ? '#4ade80' : '#f87171', fontWeight: 'bold' }}>
                            {r.pipelineResult.predictedMood}
                          </Text>{' '}
                          | True <Text style={{ color: '#e4e4e7' }}>{r.groundTruth.mood}</Text>
                        </Text>
                        <Text style={styles.entryTopics}>
                          Topics: [{r.pipelineResult.predictedTopics.join(', ')}] vs True [
                          {r.groundTruth.topics.join(', ')}]
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          )}

          {/* ======================================================== */}
          {/* TAB 2: STT AUDIO BENCHMARK (Phase 3C)                    */}
          {/* ======================================================== */}
          {activeTab === 'stt' && (
            <>
              {/* STT Configuration Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>STT Configuration</Text>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>ASR Model:</Text>
                  <Text style={styles.configValue}>Whisper small.en</Text>
                </View>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Target Clips:</Text>
                  <Text style={styles.configValue}>10 (5 English, 5 Hinglish)</Text>
                </View>
                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Whisper Status:</Text>
                  <Text
                    style={[
                      styles.configValue,
                      { color: isSttReady ? '#4ade80' : '#f87171' },
                    ]}
                  >
                    {isSttReady ? 'Loaded & Ready' : 'Loading Model...'}
                  </Text>
                </View>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Engines:</Text>
                  <Text style={styles.configValue}>
                    English clips: {WHISPER_ENGINE}. Hinglish clips: not measured yet.
                  </Text>
                </View>
              </View>

              {/* STT Runner Status & Controls */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>STT Runner Status</Text>
                <Text style={styles.statusText}>{sttStatusMessage}</Text>

                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${sttProgressPercent}%`, backgroundColor: '#10b981' },
                    ]}
                  />
                </View>
                <Text style={styles.progressCounter}>
                  {sttCurrentIndex} / {sttReferences.length} ({sttProgressPercent}%)
                </Text>

                <View style={styles.actionRow}>
                  {!isSttRunning ? (
                    <TouchableOpacity
                      style={[
                        styles.primaryButton,
                        { backgroundColor: '#059669' },
                        !isSttReady && styles.buttonDisabled,
                      ]}
                      onPress={handleStartSttBenchmark}
                      disabled={!isSttReady}
                    >
                      <Text style={styles.primaryButtonText}>
                        {sttCompletedResults.length > 0
                          ? 'Rerun STT Benchmark (English, Whisper small.en)'
                          : 'Run STT Benchmark (English, Whisper small.en)'}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.cancelButton}
                      onPress={handleCancelStt}
                    >
                      <Text style={styles.cancelButtonText}>Cancel STT</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* STT Live Metrics Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>STT Benchmark Metrics</Text>
                <View style={styles.statsGrid}>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Total Clips</Text>
                    <Text style={styles.statValue}>{sttReferences.length}</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Measured Clips</Text>
                    <Text
                      style={[
                        styles.statValue,
                        { color: sttMeasuredCount > 0 ? '#4ade80' : '#a1a1aa' },
                      ]}
                    >
                      {sttMeasuredCount} / {sttReferences.length}
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Average WER</Text>
                    <Text
                      style={[
                        styles.statValue,
                        { color: sttMeasuredCount > 0 ? '#38bdf8' : '#71717a' },
                      ]}
                    >
                      {sttAvgWer}
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Avg Latency</Text>
                    <Text
                      style={[
                        styles.statValue,
                        { color: sttMeasuredCount > 0 ? '#fafafa' : '#71717a' },
                      ]}
                    >
                      {sttAvgLatency}
                    </Text>
                  </View>
                </View>

                {sttNotMeasuredCount > 0 && sttMeasuredCount === 0 && (
                  <View style={styles.infoNotice}>
                    <Text style={styles.infoNoticeText}>
                      ℹ️ Audio clips are placeholder empty files. Record 16kHz mono WAV clips to measure real on-device WER and latency.
                    </Text>
                  </View>
                )}
              </View>

              {/* STT Export Card */}
              {sttSavedFilePath && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Export STT Results</Text>
                  <Text style={styles.exportDesc}>
                    STT results saved to app storage. Share JSON or pull via ADB:
                  </Text>

                  <TouchableOpacity style={styles.shareButton} onPress={handleShareStt}>
                    <Text style={styles.shareButtonText}>📤 Share STT Results JSON</Text>
                  </TouchableOpacity>

                  <Text style={styles.codeHeader}>PowerShell adb command:</Text>
                  <View style={styles.codeBox}>
                    <Text selectable style={styles.codeText}>
                      adb exec-out run-as com.murmur.app cat files/stt_benchmark_results.json &gt; benchmark/stt_results_device.json
                    </Text>
                  </View>
                </View>
              )}

              {/* STT References & Clips Detail */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Reference Audio Clips (10)</Text>
                {sttReferences.map((ref) => {
                  const result = sttCompletedResults.find((r) => r.id === ref.id);
                  const isMeasured = result?.status === 'completed';

                  return (
                    <View key={ref.id} style={styles.entryRow}>
                      <View style={styles.entryHeader}>
                        <Text style={styles.entryId}>
                          {ref.fileName} [{ref.language}]
                        </Text>
                        <View
                          style={[
                            styles.sttStatusBadge,
                            isMeasured ? styles.sttBadgeSuccess : styles.sttBadgePending,
                          ]}
                        >
                          <Text style={styles.sttBadgeText}>
                            {isMeasured
                              ? `WER: ${(result.wer! * 100).toFixed(1)}% (${result.transcriptionTimeMs}ms)`
                              : 'Not recorded (not measured)'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.referenceText}>
                        &ldquo;{ref.referenceTranscript}&rdquo;
                      </Text>
                      {isMeasured && result?.hypothesisTranscript && (
                        <Text style={styles.hypothesisText}>
                          Whisper: &ldquo;{result.hypothesisTranscript}&rdquo;
                        </Text>
                      )}
                      <Text style={styles.targetDurationText}>
                        Target duration: ~{ref.targetDurationSec}s • {ref.wordCount} words
                      </Text>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121214',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#f4f4f5',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#a1a1aa',
    marginTop: 2,
  },
  closeButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#27272a',
  },
  closeButtonText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#18181b',
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    gap: 8,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#27272a',
  },
  tabButtonActive: {
    backgroundColor: '#3b82f6',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#a1a1aa',
  },
  tabTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e4e4e7',
    marginBottom: 10,
  },
  configRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  configLabel: {
    fontSize: 13,
    color: '#a1a1aa',
  },
  configValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f4f4f5',
  },
  languageSelectContainer: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#27272a',
  },
  languageButtonGroup: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  langPill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#27272a',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3f3f46',
  },
  langPillActive: {
    backgroundColor: '#047857',
    borderColor: '#10b981',
  },
  langPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#a1a1aa',
  },
  langPillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  statusText: {
    fontSize: 13,
    color: '#93c5fd',
    marginBottom: 12,
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: '#27272a',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 4,
  },
  progressCounter: {
    fontSize: 12,
    color: '#71717a',
    textAlign: 'right',
    marginBottom: 14,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#dc2626',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statBox: {
    width: '48%',
    backgroundColor: '#27272a',
    padding: 10,
    borderRadius: 8,
  },
  statLabel: {
    fontSize: 11,
    color: '#a1a1aa',
    marginBottom: 2,
  },
  statValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fafafa',
  },
  infoNotice: {
    backgroundColor: '#1e293b',
    padding: 10,
    borderRadius: 6,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  infoNoticeText: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 16,
  },
  exportDesc: {
    fontSize: 12,
    color: '#a1a1aa',
    marginBottom: 12,
    lineHeight: 18,
  },
  shareButton: {
    backgroundColor: '#059669',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  shareButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  codeHeader: {
    fontSize: 11,
    color: '#71717a',
    marginBottom: 4,
  },
  codeBox: {
    backgroundColor: '#09090b',
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  codeText: {
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    fontSize: 11,
    color: '#38bdf8',
  },
  entryRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    paddingVertical: 8,
  },
  entryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  entryId: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f4f4f5',
  },
  pathBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  pathBadgeLlm: {
    backgroundColor: '#065f46',
  },
  pathBadgeRetry: {
    backgroundColor: '#78350f',
  },
  pathBadgeFallback: {
    backgroundColor: '#7f1d1d',
  },
  pathBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
  },
  sttStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sttBadgeSuccess: {
    backgroundColor: '#047857',
  },
  sttBadgePending: {
    backgroundColor: '#3f3f46',
  },
  sttBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
  },
  entryDetails: {
    fontSize: 12,
    color: '#a1a1aa',
    marginBottom: 2,
  },
  entryTopics: {
    fontSize: 11,
    color: '#71717a',
  },
  referenceText: {
    fontSize: 12,
    color: '#e4e4e7',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  hypothesisText: {
    fontSize: 12,
    color: '#38bdf8',
    marginBottom: 2,
  },
  targetDurationText: {
    fontSize: 10,
    color: '#71717a',
  },
});
