# Murmur benchmark results

Generated: 2026-11-23T17:25:03.543Z
Device run: not measured (`benchmark/device_results.json` not found).

## 1. Speech to text

Word error rate = (substitutions + deletions + insertions) / reference words. Normalization: lowercase, punctuation removed, whitespace collapsed. The Hindi engine returns Devanagari; it is converted to Roman script with the app's own converter before scoring, because the references are written in Roman script. Spelling variants of the same Hindi word (for example "bahut" and "bohot") count as errors, so Hinglish WER is pessimistic.

| Engine | Language | Clips scored | Mean WER (per clip) | Corpus WER | STT time p50 | STT time p95 | Real-time factor p50 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| not measured | | | | | | | |

STT time for the Hindi engine includes streaming the file to the recognizer in chunks, so it is not comparable to live recording, where text is ready when you stop.

## 2. Tag suggestions

Truth = the 1 to 3 tags you labelled per clip. Accuracy is reported two ways: mean per-entry Jaccard (|predicted ∩ truth| / |predicted ∪ truth|), and micro precision/recall over all clips. "Raw" = the engine output after Devanagari-to-Roman conversion (what the review card starts with); "corrected" = your reference transcript. Invalid = first model output failed JSON parsing or schema validation; retried = a second attempt was made; failed = both attempts failed and the entry would be saved without tags.

| Input | Clips | Mean Jaccard | Precision | Recall | First attempt invalid | Retried | Failed | LLM time p50 | LLM time p95 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| On-device, raw transcript | 0 | not measured | not measured | not measured | not measured | not measured | not measured | not measured | not measured |
| On-device, corrected transcript | 0 | not measured | not measured | not measured | not measured | not measured | not measured | not measured | not measured |

Cloud baseline: not measured.

## 3. Weekly report

Topics, repeated mentions and last-week counts are found by code. The model names topics, judges before/after changes and connections, and words questions; every reply is checked in code (quotes verbatim in their entries, length limits, no advice or praise) before it is shown. The useful numbers are how often proposals pass those checks and how much each week shows.

Not measured: `benchmark/insight_metrics.json` (version 2) was not found.

## How I measured this

- Dataset: 50 clips planned (25 English, 25 Hinglish), 10 to 30 s each, including short entries, sarcasm, mixed emotions, "other"-topic and multi-topic clips. 0 clips were run on the phone; 0 have a reference transcript; 0 have tag labels.
- Recorded by: one speaker (the app's author), in their own voice, on one phone, in the benchmark screen of the app (16 kHz, 16-bit, mono WAV). No other people's recordings.
- References: written by hand by the speaker after listening back, Hindi words in Roman script as they would type them.
- Labels: the speaker's own judgement of 1 to 3 topics per clip from the fixed list.
- Each clip used the engine the app uses for its language: Whisper for English, Android's on-device recognizer (file input, on-device only) for Hinglish. Tag suggestion ran through the same code path and settings as live entries.
- Limits: one speaker, one phone, one recording environment; read-aloud-style prompts are not fully spontaneous speech; Hinglish WER counts spelling variants as errors; weekly-insight numbers come from the author's own real weeks, a small sample; timings depend on phone temperature and background load.
