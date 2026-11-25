import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenModal } from '../components/ScreenModal';
import { Directory, File, Paths } from 'expo-file-system';
import { useAudioPlayer, useAudioStream } from 'expo-audio';
import clipsRaw from '../../benchmark/clips.json';
import type {
  BenchmarkClip,
  ClipRunResult,
  DeviceRunPayload,
  InsightMetricsPayload,
  TagRunRecord,
} from '../types/benchmarkRun';
import type { TagSuggestionResult } from '../services/tagSuggestion';
import { decodeWavBytes } from '../utils/wavDecoder';
import { transcribeFileOnDevice } from '../services/fileRecognizer';
import { convertDevanagariToHinglish } from '../services/hinglishTransliteration';
import { loadAllCachedReports } from '../services/insightCache';
import { fileStamp, saveTextToUserFolder } from '../services/exportFile';

const clips = clipsRaw as BenchmarkClip[];
const CLIP_DIR_NAME = 'benchmark_audio';
const MAX_CLIP_SECONDS = 35;

interface BenchmarkRunnerScreenProps {
  visible: boolean;
  onClose: () => void;
  isSttReady: boolean;
  /** Whisper transcription of 16 kHz mono samples with the current English variant. */
  transcribeEnglish: (samples: Float32Array) => Promise<string>;
  englishEngine: string;
  englishModelPath: string;
  isLlmReady: boolean;
  llmName: string;
  /** Tag suggestion through the app's model queue. */
  suggestTags: (text: string) => Promise<TagSuggestionResult>;
  /** True while the main screen is recording or transcribing. */
  appBusy: boolean;
}

function clipDir(): Directory {
  const dir = new Directory(Paths.document, CLIP_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function clipFile(clip: BenchmarkClip): File {
  return new File(clipDir(), clip.fileName);
}

/** Seconds of audio in a 16-bit mono 16 kHz WAV, from its size. null if missing. */
function clipSeconds(clip: BenchmarkClip): number | null {
  const f = clipFile(clip);
  if (!f.exists || f.size <= 44) return null;
  return (f.size - 44) / (16000 * 2);
}

/** Calls onTick with whole seconds elapsed, every 250 ms. */
function startSecondsTicker(onTick: (seconds: number) => void): ReturnType<typeof setInterval> {
  const startedAt = Date.now();
  return setInterval(() => onTick(Math.floor((Date.now() - startedAt) / 1000)), 250);
}

function toTagRecord(input: 'raw' | 'corrected', text: string, r: TagSuggestionResult): TagRunRecord {
  return {
    input,
    inputChars: text.length,
    tags: r.tags,
    tagStatus: r.status,
    llmMs: r.llmMs,
    retryCount: r.retryCount,
    firstAttemptValid: r.attempts[0]?.outcome === 'valid',
    attemptOutcomes: r.attempts.map((a) => a.outcome),
  };
}

function deviceInfo(): DeviceRunPayload['device'] {
  const c = Platform.constants as unknown as { Manufacturer?: string; Model?: string; Release?: string };
  return {
    manufacturer: c.Manufacturer ?? 'unknown',
    model: c.Model ?? 'unknown',
    androidVersion: c.Release ?? 'unknown',
    apiLevel: typeof Platform.Version === 'number' ? Platform.Version : 0,
  };
}

/**
 * Dev-only benchmark runner. Records your 50 clips as 16 kHz 16-bit mono WAV in
 * the app's private documents folder, runs each clip through the engine the app
 * uses for its language, runs tag suggestion on both the raw transcript and
 * your corrected reference, and exports the results to a folder you pick.
 */
export function BenchmarkRunnerScreen(props: BenchmarkRunnerScreenProps) {
  const { visible, onClose } = props;
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<ClipRunResult[]>([]);
  const cancelRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' });
  const player = useAudioPlayer(null);

  const recordedCount = useMemo(
    () => clips.filter((c) => clipSeconds(c) !== null).length,
    // refreshKey changes after each recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey, visible]
  );
  const referencedCount = clips.filter((c) => c.referenceTranscript.trim().length > 0).length;

  const stopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      await stream.stopFileRecordingAsync();
    } catch {
      // ignore
    }
    stream.stop();
    setRecordingId(null);
    setRefreshKey((k) => k + 1);
  }, [stream]);

  const stopRef = useRef(stopRecording);
  useEffect(() => {
    stopRef.current = stopRecording;
  }, [stopRecording]);

  const startRecording = async (clip: BenchmarkClip) => {
    if (props.appBusy || running || recordingId) return;
    const target = clipFile(clip);
    // The writer appends to an existing file, so delete it first.
    if (target.exists) target.delete();
    try {
      await stream.start();
      await stream.startFileRecordingAsync({ uri: target.uri, format: 'wav' });
    } catch (err: unknown) {
      Alert.alert('Recording failed', err instanceof Error ? err.message : 'Unknown error');
      return;
    }
    setRecordingId(clip.id);
    setElapsed(0);
    timerRef.current = startSecondsTicker((s) => {
      setElapsed(s);
      if (s >= MAX_CLIP_SECONDS) stopRef.current();
    });
  };

  const play = (clip: BenchmarkClip) => {
    const f = clipFile(clip);
    if (!f.exists) return;
    player.replace({ uri: f.uri });
    player.play();
  };

  const runBenchmark = async () => {
    if (!props.isSttReady || !props.isLlmReady) {
      Alert.alert('Models not ready', 'Wait until Whisper and the tag model have loaded.');
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    const out: ClipRunResult[] = [];

    for (let i = 0; i < clips.length; i++) {
      if (cancelRef.current) break;
      const clip = clips[i];
      const engine = clip.language === 'en' ? props.englishEngine : 'android_ondevice_hi';
      setProgress(`Clip ${i + 1}/${clips.length} (${clip.id})`);
      const base: ClipRunResult = {
        id: clip.id,
        language: clip.language,
        sttEngine: engine,
        status: 'not_measured',
        note: null,
        audioMs: null,
        sttMs: null,
        rawTranscript: null,
        rawTranscriptRoman: null,
        tagsOnRaw: null,
        tagsOnCorrected: null,
      };

      const seconds = clipSeconds(clip);
      if (seconds === null) {
        out.push({ ...base, note: 'clip not recorded' });
        setResults([...out]);
        continue;
      }

      try {
        let raw: string;
        let sttMs: number;
        const audioMs = Math.round(seconds * 1000);
        if (clip.language === 'en') {
          const bytes = new Uint8Array(await clipFile(clip).arrayBuffer());
          const samples = decodeWavBytes(bytes).samples;
          const t0 = performance.now();
          raw = await props.transcribeEnglish(samples);
          sttMs = Math.round(performance.now() - t0);
        } else {
          const r = await transcribeFileOnDevice(clipFile(clip).uri, audioMs);
          if (r.errorCode === 'gate_failed') {
            out.push({ ...base, status: 'error', note: `on-device gate failed: ${r.gate.ok ? '' : r.gate.reason}` });
            setResults([...out]);
            continue;
          }
          raw = r.transcript;
          sttMs = r.sttMs;
          if (r.errorCode && !raw.trim()) {
            out.push({ ...base, status: 'error', audioMs, sttMs, note: `recognizer error: ${r.errorCode}` });
            setResults([...out]);
            continue;
          }
        }

        const roman = convertDevanagariToHinglish(raw);
        const tagsOnRaw = roman.trim()
          ? toTagRecord('raw', roman, await props.suggestTags(roman))
          : null;
        const reference = clip.referenceTranscript.trim();
        const tagsOnCorrected = reference
          ? toTagRecord('corrected', reference, await props.suggestTags(reference))
          : null;

        out.push({
          ...base,
          status: 'completed',
          note: reference ? null : 'no reference transcript yet',
          audioMs,
          sttMs,
          rawTranscript: raw,
          rawTranscriptRoman: roman,
          tagsOnRaw,
          tagsOnCorrected,
        });
      } catch (err: unknown) {
        out.push({ ...base, status: 'error', note: err instanceof Error ? err.name : 'error' });
      }
      setResults([...out]);
    }

    setRunning(false);
    setProgress(cancelRef.current ? `Cancelled after ${out.length} clips.` : `Finished ${out.length} clips.`);
    // Metadata only.
    console.log(
      '[BENCH-RUN] ' +
        JSON.stringify({
          clips: out.length,
          completed: out.filter((r) => r.status === 'completed').length,
          notMeasured: out.filter((r) => r.status === 'not_measured').length,
          errors: out.filter((r) => r.status === 'error').length,
        })
    );
  };

  const exportResults = async () => {
    if (results.length === 0) return;
    const payload: DeviceRunPayload = {
      kind: 'murmur-benchmark-device-run',
      version: 1,
      timestamp: new Date().toISOString(),
      device: deviceInfo(),
      build: __DEV__ ? 'debug-js' : 'release-js',
      models: {
        englishStt: { engine: props.englishEngine, modelPath: props.englishModelPath },
        hinglishStt: { engine: 'android_ondevice_hi', recognizer: 'SpeechRecognizer.createOnDeviceSpeechRecognizer, hi-IN' },
        llm: props.llmName,
      },
      clips: results,
    };
    Alert.alert(
      'Export is not encrypted',
      'The file contains the transcripts of your benchmark clips in plain text. Save it only somewhere you trust, then copy it to benchmark/device_results.json on your laptop.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Choose folder',
          onPress: async () => {
            const uri = await saveTextToUserFolder(
              `murmur_device_results_${fileStamp()}.json`,
              'application/json',
              JSON.stringify(payload, null, 2)
            ).catch(() => null);
            if (uri) Alert.alert('Saved', 'Results saved to the folder you chose.');
          },
        },
      ]
    );
  };

  const exportInsightMetrics = async () => {
    const rows = await loadAllCachedReports().catch(() => []);
    const payload: InsightMetricsPayload = {
      kind: 'murmur-insight-metrics',
      version: 2,
      timestamp: new Date().toISOString(),
      weeks: rows.map(({ weekKey, value }) => ({
        weekKey,
        entryCount: value.entryCount,
        syntheticCount: value.syntheticCount,
        droppedAsStale: value.droppedAsStale,
        shown: {
          topics: value.report.topics.length,
          namedTopics: value.report.topics.filter((t) => t.label !== null).length,
          changes: value.report.changes.length,
          connections: value.report.connections.length,
          questions: value.report.questions.length,
        },
        metrics: value.report.metrics,
      })),
    };
    const uri = await saveTextToUserFolder(
      `murmur_insight_metrics_${fileStamp()}.json`,
      'application/json',
      JSON.stringify(payload, null, 2)
    ).catch(() => null);
    if (uri) Alert.alert('Saved', `Exported metrics for ${rows.length} week(s). No journal text is included.`);
  };

  const close = () => {
    if (recordingId) stopRecording();
    cancelRef.current = true;
    onClose();
  };

  return (
    <ScreenModal visible={visible} onRequestClose={close}>
        <View style={styles.header}>
          <Text style={styles.title}>Benchmark (dev only)</Text>
          <TouchableOpacity onPress={close}>
            <Text style={styles.link}>Close</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Status</Text>
            <Text style={styles.text}>Recorded clips: {recordedCount} / {clips.length}</Text>
            <Text style={styles.text}>Reference transcripts in clips.json: {referencedCount} / {clips.length}</Text>
            <Text style={styles.text}>English engine: {props.englishEngine}</Text>
            <Text style={styles.text}>Hinglish engine: android_ondevice_hi (file input, on-device only)</Text>
            <Text style={styles.small}>
              Clips are saved inside the app (not backed up) as 16 kHz 16-bit mono WAV.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Run</Text>
            {running ? (
              <>
                <View style={styles.row}>
                  <ActivityIndicator color="#38BDF8" />
                  <Text style={styles.text}>{progress}</Text>
                </View>
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => (cancelRef.current = true)}>
                  <Text style={styles.secondaryText}>Cancel after this clip</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {progress ? <Text style={styles.text}>{progress}</Text> : null}
                <TouchableOpacity
                  style={[styles.primaryBtn, (props.appBusy || recordingId !== null) && styles.disabled]}
                  onPress={runBenchmark}
                  disabled={props.appBusy || recordingId !== null}
                >
                  <Text style={styles.primaryText}>Run all clips</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryBtn, results.length === 0 && styles.disabled]}
                  onPress={exportResults}
                  disabled={results.length === 0}
                >
                  <Text style={styles.secondaryText}>Export device results (JSON)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryBtn} onPress={exportInsightMetrics}>
                  <Text style={styles.secondaryText}>Export weekly report metrics (no text)</Text>
                </TouchableOpacity>
              </>
            )}
            {results.length > 0 ? (
              <Text style={styles.small}>
                {results.filter((r) => r.status === 'completed').length} completed,{' '}
                {results.filter((r) => r.status === 'not_measured').length} not measured,{' '}
                {results.filter((r) => r.status === 'error').length} errors.
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Clips</Text>
            <Text style={styles.small}>
              Tap Record, talk about the prompt for about the target length, tap Stop. Play it back
              and write exactly what you said into benchmark/clips.json on your laptop.
            </Text>
            {clips.map((clip) => {
              const secs = clipSeconds(clip);
              const isRec = recordingId === clip.id;
              return (
                <View key={clip.id} style={styles.clipRow}>
                  <View style={styles.clipInfo}>
                    <Text style={styles.clipId}>
                      {clip.id} · {clip.targetSeconds}s{clip.hardCase ? ` · ${clip.hardCase}` : ''}
                    </Text>
                    <Text style={styles.clipPrompt}>{clip.prompt}</Text>
                    <Text style={styles.small}>
                      {isRec ? `Recording… ${elapsed}s` : secs !== null ? `Recorded ${secs.toFixed(1)}s` : 'Not recorded'}
                    </Text>
                  </View>
                  <View style={styles.clipButtons}>
                    {isRec ? (
                      <TouchableOpacity style={styles.stopBtn} onPress={stopRecording}>
                        <Text style={styles.primaryText}>Stop</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={[styles.recBtn, (recordingId !== null || running || props.appBusy) && styles.disabled]}
                        onPress={() => startRecording(clip)}
                        disabled={recordingId !== null || running || props.appBusy}
                      >
                        <Text style={styles.primaryText}>{secs !== null ? 'Redo' : 'Record'}</Text>
                      </TouchableOpacity>
                    )}
                    {secs !== null && !isRec ? (
                      <TouchableOpacity style={styles.playBtn} onPress={() => play(clip)}>
                        <Text style={styles.secondaryText}>Play</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </ScreenModal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#09090B' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#27272A',
  },
  title: { color: '#F4F4F5', fontSize: 17, fontWeight: '800' },
  link: { color: '#38BDF8', fontSize: 14, fontWeight: '700' },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  card: { backgroundColor: '#18181B', borderRadius: 12, padding: 14, gap: 6, borderWidth: 1, borderColor: '#27272A' },
  cardTitle: { color: '#F4F4F5', fontSize: 14, fontWeight: '800', marginBottom: 2 },
  text: { color: '#D4D4D8', fontSize: 13 },
  small: { color: '#A1A1AA', fontSize: 11, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primaryBtn: { backgroundColor: '#059669', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  primaryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderColor: '#3F3F46', borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginTop: 4 },
  secondaryText: { color: '#E4E4E7', fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  clipRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#27272A' },
  clipInfo: { flex: 1, gap: 2 },
  clipId: { color: '#F4F4F5', fontSize: 12, fontWeight: '700' },
  clipPrompt: { color: '#D4D4D8', fontSize: 12, lineHeight: 17 },
  clipButtons: { gap: 6, justifyContent: 'center' },
  recBtn: { backgroundColor: '#DC2626', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center' },
  stopBtn: { backgroundColor: '#B91C1C', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center' },
  playBtn: { borderWidth: 1, borderColor: '#3F3F46', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12, alignItems: 'center' },
});
