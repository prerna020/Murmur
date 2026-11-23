/**
 * Optional cloud baseline for TAG suggestion. Runs on the laptop only; the app
 * contains no cloud code. Uses the same prompt and validation as the app.
 *
 * Input: the corrected reference transcripts in benchmark/clips.json, which you
 * wrote yourself (your own consented data). Do not run it on anyone else's data.
 * Output: benchmark/cloud_baseline.json, read by `npm run benchmark:score`.
 *
 * PowerShell:
 *   $env:GEMINI_API_KEY = "<your key>"      # never commit or paste it into files
 *   $env:GEMINI_MODEL   = "<model id>"      # e.g. a current Gemini Flash model id
 *   npm run benchmark:gemini
 *   Remove-Item Env:GEMINI_API_KEY
 *
 * The key is read from the environment and sent in the x-goog-api-key header,
 * not in the URL. It is never written to disk or printed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTagPrompt, parseTagReply } from '../src/services/tagSuggestion.ts';
import type { BenchmarkClip } from '../src/types/benchmarkRun.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function callGemini(apiKey: string, model: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) {
    console.error('Set GEMINI_API_KEY and GEMINI_MODEL in the environment first (see the header of this file).');
    process.exit(1);
  }

  const clips = JSON.parse(fs.readFileSync(path.join(here, 'clips.json'), 'utf8')) as BenchmarkClip[];
  const todo = clips.filter((c) => c.referenceTranscript.trim().length > 0);
  console.log(`Cloud baseline: ${todo.length} clips with a reference transcript, model ${model}.`);

  const results: { id: string; tags: string[]; valid: boolean }[] = [];
  for (const clip of todo) {
    let tags: string[] = [];
    let valid = false;
    try {
      const reply = await callGemini(apiKey, model, buildTagPrompt(clip.referenceTranscript));
      const parsed = parseTagReply(reply);
      valid = parsed !== null;
      tags = parsed ?? [];
    } catch (err: unknown) {
      console.error(`${clip.id}: ${err instanceof Error ? err.message : 'request failed'}`);
    }
    results.push({ id: clip.id, tags, valid });
    console.log(`${clip.id}: ${valid ? 'valid' : 'invalid'}`);
  }

  fs.writeFileSync(
    path.join(here, 'cloud_baseline.json'),
    JSON.stringify({ kind: 'murmur-cloud-baseline', model, timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log('Wrote benchmark/cloud_baseline.json');
}

main();
