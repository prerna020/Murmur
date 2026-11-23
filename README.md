# Murmur

A private voice journal for Android. You speak for up to 60 seconds in English or
Hinglish, correct the transcript, optionally tap a mood and pick up to 3 tags, and
save. A weekly recap counts your entries, tags and moods, and can show one
automatically found connection between two of your own entries, quoted word for
word.

Everything runs on the phone. After a one-time model download the app works in
airplane mode.

## Privacy design

- **No network in the journal flow.** Record → transcribe → correct → save →
  recap all run on the phone. The app has no analytics, no crash reporting and no
  cloud API calls; model download telemetry is turned off
  (`setTelemetryEnabled(false)`). The only network use is the first-run model
  download.
- **Encrypted storage.** Entries, drafts, weekly insights and settings live in one
  SQLCipher database. Its 256-bit key is generated on the phone and stored in the
  Android Keystore via `expo-secure-store`.
- **No backups.** `allowBackup="false"` plus data-extraction rules exclude all app
  data from cloud backup and device-to-device transfer
  (`plugins/withBackupExclusion.js`).
- **Audio is temporary.** English audio is a cache WAV that is deleted only after
  the entry is saved and read back from the database; leftovers are deleted at the
  next launch. Hindi audio is never written by Murmur.
- **Mood is yours.** Mood is an optional one-tap choice and is never inferred from
  text.
- **No journal text in logs.** Log lines (`[STT-TIMING]`, `[TAG-TIMING]`,
  `[HI-STT]`, `[INSIGHT-RUN]`, …) carry timings and counts only.
  `expo-speech-recognition` logged transcripts to logcat; `patches/` removes that.
- **Exports only on request.** Settings → Export writes an unencrypted JSON file to
  a folder you pick, after a warning.

## Architecture

| Part | Implementation |
|---|---|
| App | Expo SDK 58, React Native 0.88, TypeScript (strict), Android only |
| English speech-to-text | Whisper small.en via `react-native-executorch` 0.11.0 |
| Hindi/Hinglish speech-to-text | Android `SpeechRecognizer.createOnDeviceSpeechRecognizer`, locale hi-IN, via `expo-speech-recognition` 58.0.1 |
| Tag suggestions and weekly insight | Qwen 3 0.6B (XNNPACK, 8da4w) via `react-native-executorch`, thinking disabled |
| Storage | `expo-sqlite` with SQLCipher, key in `expo-secure-store` |
| Reminders | `expo-notifications`, local daily trigger only |

Main code:

- `App.tsx`: recording, review, save flow, model queue.
- `src/hooks/useHindiRecognizer.ts`, `src/services/hindiGate.ts`: Hindi engine and its hard gate.
- `src/services/tagSuggestion.ts`: tag prompt, zod validation, one retry, timeout.
- `src/services/insightPairs.ts`, `insight.ts`, `insightCache.ts`: weekly insight.
- `src/services/database.ts`, `drafts.ts`: encrypted storage and migrations.
- `src/screens/SettingsScreen.tsx`: reminder, privacy screen, export, delete all.
- `src/screens/BenchmarkRunnerScreen.tsx`, `benchmark/`: benchmark (dev tools only).

### Tags

The model suggests up to 3 of `work_study, relationships, family, health, money,
goals, leisure, other` in the background while you review. You can remove them,
add from the list, or type a custom tag (trimmed, lowercased, max 24 characters,
no duplicates, max 3 tags in total). Output is parsed defensively, validated
with zod, retried once with the specific error, and stopped after 20 s per
attempt. If both attempts fail the entry is saved without tags and
`tagStatus = "failed"`. There is no keyword fallback. Saving never waits for the
model.

### Weekly insight

Counts are computed in code. With 3 or more entries in the week, code picks up to
3 candidate pairs that share a tag and meaningful words (stop words in English
and Hinglish removed). The model sees only the two corrected transcripts of one
pair and must answer `{"supported": false}` unless they are clearly about the
same event. An insight is accepted only if code verifies it: valid JSON, one
excerpt from each entry, each excerpt a verbatim substring of its entry
(whitespace and case normalized only), insight ≤ 30 words. One retry per pair,
at most one insight per week, cached in the encrypted database, hidden as stale
if an edit breaks an excerpt. No verified insight means counts only. The week
is a rolling 7 days.

## The two-engine decision

- **English uses Whisper small.en.** It runs fully inside the app.
- **Hindi/Hinglish uses Android's on-device recognizer.** The multilingual Whisper
  small model produced mostly wrong Devanagari on the author's Hinglish speech,
  also with the full-precision build (the author's observation; not measured
  with WER). Google's on-device hi-IN recognizer got most Hindi words right in
  the same test (also an observation). Measured WER for both is in
  `benchmark/results.md` once the benchmark has been run.
- **Hard gate, no cloud fallback.** Hindi recording is allowed only if Android is
  13+ (API 33, where on-device mode is enforced), `supportsOnDeviceRecognition()`
  is true and hi-IN is in the recognizer's installed on-device languages.
  Otherwise the app shows an "Install Hindi pack" button and does not record.
- **Cost of this choice.** The Hindi engine depends on Google's Android System
  Intelligence and its downloadable language pack. It returns Devanagari, which
  Murmur converts to Roman script in the editable draft. The raw output is kept
  as `rawTranscript`, and each entry stores which engine produced it
  (`sttEngine`).

## Benchmark

Current state: **not measured.** The 50-clip benchmark (25 English, 25 Hinglish,
recorded by the author) has not been run yet. `benchmark/results.md` is
regenerated by `npm run benchmark:score` and shows "not measured" for every cell
until the device results exist. See `docs/BENCHMARK_GUIDE.md`.

The only measurements so far are two tag-suggestion runs before the speed
fixes, on an OPPO CPH2665 (Android 16), release JS build:

| Entry | Engine | Prompt tokens | Generated tokens | Total |
|---|---|---|---|---|
| English | Whisper small.en | 203 | 192 (about 96% thinking text) | 18.4 s |
| Hinglish | Android on-device hi-IN | 500 | 315 | 52.1 s |

Both returned the prompt's example tags verbatim. The fixes (thinking off,
40-token cap, shorter prompt without an example, 500-character input cap, 20 s
timeout) are **not measured yet**.

## Known limitations

- **Hinglish quality.** The recognizer writes English words in Devanagari;
  conversion back to English spelling relies on a fixed word list, so less common
  English words come out as phonetic spellings (e.g. "prejentesan") until you
  correct them. Hindi words have no single Roman spelling.
- **Tag model.** 0.6B parameters; quality on mixed-language text is limited.
  Tags are based on the first 500 characters of an entry.
- **English speed.** Whisper processes audio in 29 s windows after you stop; a
  30 s entry takes noticeably longer than Hindi, which transcribes while you talk.
  Backend (CPU/GPU) and model (small.en/base.en) are not chosen from measurements
  yet; see `docs/STT_TIMING.md`.
- **One speaker, one phone.** All evaluation is the author's voice on one OPPO
  phone. Results will differ for other voices, accents and phones.
- **Debug vs release.** Speeds differ a lot between debug and release JS
  builds. Only release-build numbers should be compared (`build` field in logs).
- **Hindi engine availability** depends on the phone shipping Google's
  on-device recognizer and the user installing the hi-IN pack; other OEM
  recognizers are not supported.
- **Hindi benchmark file input** (feeding WAV files to the recognizer) is
  supported by the library on Android 13+ but not yet verified on this phone.

## Setup and run (Windows, PowerShell)

Prerequisites: Node.js, Android Studio (SDK + platform-tools, NDK 27), a phone
with USB debugging on, and the repo at a short path such as `C:\dev\Murmur` (long
native build paths break on Windows; see `docs/RELEASE_BUILD.md`).

```powershell
cd C:\dev\Murmur
npm install                                  # also applies patches/ via postinstall
[Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
# open a new terminal, then:
$env:Path += ";$env:LOCALAPPDATA\Android\Sdk\platform-tools"
adb devices
npx expo run:android --variant release --device
```

First launch downloads the models (needs internet once). For Hindi, open the
Hindi tab and install the Hindi (India) pack if asked.

Checks (all must pass before a change is done):

```powershell
npx tsc --noEmit
npx expo lint
npm test
```

Dev tools (benchmark screen, Whisper backend/model switch) are off in release
builds. To include them in a measurement build, create `.env.local` with
`EXPO_PUBLIC_MURMUR_DEV_TOOLS=1` and rebuild; delete it afterwards. Synthetic
test data can only be seeded in debug builds.

Docs: `docs/RELEASE_BUILD.md` (build, verify not debuggable, timing logs),
`docs/STT_TIMING.md` (English timing table), `docs/BENCHMARK_GUIDE.md`
(50-clip benchmark), `docs/ACCEPTANCE_TEST.md` (airplane-mode test),
`benchmark/MEASURING.md` (RAM, battery, storage).
