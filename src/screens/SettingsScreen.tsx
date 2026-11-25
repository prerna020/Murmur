import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { JournalEntry } from '../types/journal';
import { hindiGateMessage, type HindiGateResult } from '../services/hindiGate';
import {
  DEFAULT_REMINDER,
  REMINDER_BODY,
  applyReminderSettings,
  formatTime,
  loadReminderSettings,
  type ReminderSettings,
} from '../services/reminders';
import { formatBytes, measureStorage, type StorageUsage } from '../services/storage';
import { buildEntriesExport } from '../services/exportEntries';
import { fileStamp, saveTextToUserFolder } from '../services/exportFile';

interface SettingsScreenProps {
  entries: JournalEntry[];
  englishEngineLabel: string;
  englishModelFile: string;
  isWhisperReady: boolean;
  llmName: string;
  isLlmReady: boolean;
  hindiGate: HindiGateResult | null;
  onRecheckHindi: () => void;
  /** Wipes all data. Resolves when done. */
  onDeleteAll: (alsoModels: boolean) => Promise<void>;
}

export function SettingsScreen(props: SettingsScreenProps) {
  const [reminder, setReminder] = useState<ReminderSettings>(DEFAULT_REMINDER);
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  const [savingReminder, setSavingReminder] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refreshUsage = useCallback(() => {
    measureStorage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadReminderSettings()
      .then((s) => {
        if (!cancelled) setReminder(s);
      })
      .catch(() => undefined);
    measureStorage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const saveReminder = async (next: ReminderSettings) => {
    setSavingReminder(true);
    setReminderNote(null);
    try {
      const { settings, permission } = await applyReminderSettings(next);
      setReminder(settings);
      if (next.enabled && permission === 'denied') {
        setReminderNote('Notification permission was not granted, so the reminder is off.');
      } else if (next.enabled && permission === 'blocked') {
        setReminderNote('Notifications are blocked for Murmur. Allow them in system settings, then turn the reminder on again.');
      }
    } catch (err: unknown) {
      setReminderNote(err instanceof Error ? err.message : 'Could not update the reminder.');
    } finally {
      setSavingReminder(false);
    }
  };

  const step = (field: 'hour' | 'minute', delta: number) => {
    const max = field === 'hour' ? 24 : 60;
    const value = (reminder[field] + delta + max) % max;
    const next = { ...reminder, [field]: value };
    setReminder(next);
    if (reminder.enabled) saveReminder(next);
    else saveReminder({ ...next, enabled: false });
  };

  const exportEntries = () => {
    Alert.alert(
      'Export is not encrypted',
      `This saves all ${props.entries.length} entries, including transcripts, moods and tags, as a plain JSON file in a folder you choose. Anyone who can open that folder can read it. Murmur does not send it anywhere.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Choose folder',
          onPress: async () => {
            try {
              const uri = await saveTextToUserFolder(
                `murmur_export_${fileStamp()}.json`,
                'application/json',
                buildEntriesExport(props.entries)
              );
              if (uri) Alert.alert('Exported', 'The file was saved to the folder you chose.');
            } catch (err: unknown) {
              Alert.alert('Export failed', err instanceof Error ? err.message : 'Unknown error');
            }
          },
        },
      ]
    );
  };

  const runDelete = async (alsoModels: boolean) => {
    setDeleting(true);
    try {
      await props.onDeleteAll(alsoModels);
      setReminder(DEFAULT_REMINDER);
      refreshUsage();
      Alert.alert(
        'Deleted',
        alsoModels
          ? 'All journal data and the downloaded models were deleted. Close and reopen Murmur to download the models again.'
          : 'All journal data was deleted.'
      );
    } catch (err: unknown) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete all data?',
      'This permanently deletes every entry, the encryption key, drafts, weekly insights, reminder settings, temporary audio and benchmark clips. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete data, keep models',
          style: 'destructive',
          onPress: () => runDelete(false),
        },
        {
          text: 'Also delete models',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Also delete downloaded models?',
              `The Whisper and tag models (${usage ? formatBytes(usage.modelsBytes) : 'size not measured'}) will need to be downloaded again, which needs internet once. The Hindi speech pack belongs to Android and is not removed.`,
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete everything', style: 'destructive', onPress: () => runDelete(true) },
              ]
            ),
        },
      ]
    );
  };

  const hindiStatus =
    props.hindiGate === null
      ? 'Not checked yet. Open the Hindi tab or tap Check.'
      : props.hindiGate.ok
        ? 'Installed and on-device recognition available.'
        : hindiGateMessage(props.hindiGate.reason);

  return (
    <View style={styles.container}>
      {/* Reminder */}
      <View style={styles.card}>
        <Text style={styles.title}>Daily reminder</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.text}>Remind me every day</Text>
          <Switch
            value={reminder.enabled}
            disabled={savingReminder}
            onValueChange={(on) => saveReminder({ ...reminder, enabled: on })}
            trackColor={{ false: '#3A3A3C', true: '#FFFFFF' }}
            thumbColor={reminder.enabled ? '#000000' : '#9A9AA0'}
          />
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.text}>Time</Text>
          <View style={styles.row}>
            <Stepper label="−h" onPress={() => step('hour', -1)} disabled={savingReminder} />
            <Text style={styles.time}>{formatTime(reminder.hour, reminder.minute)}</Text>
            <Stepper label="+h" onPress={() => step('hour', 1)} disabled={savingReminder} />
            <Stepper label="−5m" onPress={() => step('minute', -5)} disabled={savingReminder} />
            <Stepper label="+5m" onPress={() => step('minute', 5)} disabled={savingReminder} />
          </View>
        </View>
        <Text style={styles.small}>
          Local notification scheduled on the phone, no server. It always says: “{REMINDER_BODY}” and
          never shows journal content.
        </Text>
        {reminderNote ? (
          <>
            <Text style={styles.warn}>{reminderNote}</Text>
            <TouchableOpacity onPress={() => Linking.openSettings()}>
              <Text style={styles.link}>Open app settings</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>

      {/* Engines and models */}
      <View style={styles.card}>
        <Text style={styles.title}>Speech and models</Text>
        <Text style={styles.text}>English: {props.englishEngineLabel}</Text>
        <Text style={styles.small}>
          File {props.englishModelFile} · {props.isWhisperReady ? 'loaded' : 'not loaded'}
        </Text>
        <Text style={styles.text}>Hindi / Hinglish: Android on-device recognizer, hi-IN</Text>
        <Text style={styles.small}>Hindi pack: {hindiStatus}</Text>
        <TouchableOpacity onPress={props.onRecheckHindi}>
          <Text style={styles.link}>Check Hindi pack</Text>
        </TouchableOpacity>
        <Text style={styles.text}>Tag suggestions: {props.llmName}</Text>
        <Text style={styles.small}>{props.isLlmReady ? 'loaded' : 'not loaded'}</Text>
      </View>

      {/* Storage */}
      <View style={styles.card}>
        <Text style={styles.title}>Storage used</Text>
        {usage ? (
          <>
            <Line label="Encrypted journal database" value={formatBytes(usage.databaseBytes)} />
            <Line label="Downloaded models (Whisper, tag model)" value={formatBytes(usage.modelsBytes)} />
            <Line label="Temporary audio" value={formatBytes(usage.tempAudioBytes)} />
            <Line label="Benchmark clips (dev)" value={formatBytes(usage.benchmarkClipsBytes)} />
          </>
        ) : (
          <Text style={styles.small}>Not measured.</Text>
        )}
        <Text style={styles.small}>The Hindi pack is stored by Android, not by Murmur.</Text>
        <TouchableOpacity onPress={refreshUsage}>
          <Text style={styles.link}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {/* Privacy */}
      <View style={styles.card}>
        <Text style={styles.title}>Privacy: what is stored and where</Text>
        <Bullet text="Entries (raw and corrected transcript, speech engine, your mood choice, tags, timings), the entry you are editing, weekly insights and reminder settings: one SQLCipher-encrypted database in Murmur’s private storage." />
        <Bullet text="Database key: 256-bit, kept in the Android Keystore (expo-secure-store), only on this phone." />
        <Bullet text="English recordings: a temporary WAV in Murmur’s cache, deleted once the entry is saved or discarded; leftovers are deleted at the next launch. No audio is kept after saving." />
        <Bullet text="Hindi recordings: Android’s on-device recognizer hears the microphone directly; Murmur keeps no audio file." />
        <Bullet text="Models: Whisper and the tag model are files in Murmur’s private storage, downloaded once. The Hindi pack is part of Android." />
        <Bullet text="Backups: all Murmur data is excluded from Android cloud backup and device-to-device transfer." />
        <Bullet text="Network: recording, transcription, tagging, saving and the recap all run on the phone. Murmur sends no journal data anywhere, has no analytics or crash reporting, and the model download telemetry is turned off. The only network use is the one-time model download." />
        <Bullet text="Exports: only when you tap Export, to a folder you choose, as an unencrypted file." />
      </View>

      {/* Data */}
      <View style={styles.card}>
        <Text style={styles.title}>Your data</Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={exportEntries} disabled={deleting}>
          <Text style={styles.secondaryText}>Export entries as JSON…</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.dangerBtn} onPress={confirmDelete} disabled={deleting}>
          {deleting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.dangerText}>Delete all data…</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Stepper({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity style={[styles.stepper, disabled && styles.disabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.stepperText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.text}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return <Text style={styles.bullet}>• {text}</Text>;
}

const styles = StyleSheet.create({
  container: { width: '100%' },
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#262628',
    marginBottom: 16,
    gap: 8,
  },
  title: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  text: { color: '#EDEDF0', fontSize: 13, flexShrink: 1 },
  value: { color: '#9A9AA0', fontSize: 13, fontWeight: '600' },
  small: { color: '#9A9AA0', fontSize: 12, lineHeight: 17 },
  warn: { color: '#FFD60A', fontSize: 12, lineHeight: 17 },
  link: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  bullet: { color: '#D1D1D6', fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  time: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', minWidth: 52, textAlign: 'center' },
  stepper: { borderWidth: 1, borderColor: '#3A3A3C', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4 },
  stepperText: { color: '#EDEDF0', fontSize: 11, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  secondaryBtn: { borderWidth: 1, borderColor: '#3A3A3C', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  secondaryText: { color: '#EDEDF0', fontSize: 13, fontWeight: '600' },
  dangerBtn: { backgroundColor: '#FF453A', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  dangerText: { color: '#000000', fontSize: 13, fontWeight: '700' },
});
