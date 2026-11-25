import { Directory, File, Paths } from 'expo-file-system';
import RNBlobUtil from 'react-native-blob-util';

/**
 * On-disk locations Murmur uses, and helpers to measure and delete them.
 *
 * Model folder: react-native-executorch 0.11.0 stores downloads in
 * `${SDCardDir || DocumentDir}/react-native-executorch` on Android, the app's
 * private external files folder (see src/fetcher/fetcher.ts in the library).
 * The same expression is used here so the path matches.
 */
export const MODELS_DIR = `${RNBlobUtil.fs.dirs.SDCardDir || RNBlobUtil.fs.dirs.DocumentDir}/react-native-executorch`;

const DB_FILE_NAMES = ['murmur_encrypted.db', 'murmur_encrypted.db-wal', 'murmur_encrypted.db-shm'];
const BENCHMARK_DIR = 'benchmark_audio';
const AUDIO_EXT = /\.(wav|m4a|pcm)$/i;

function sumFiles(dir: Directory, filter?: (name: string) => boolean): number {
  if (!dir.exists) return 0;
  let total = 0;
  for (const item of dir.list()) {
    if (item instanceof File) {
      if (!filter || filter(item.name)) total += item.size ?? 0;
    } else if (item instanceof Directory) {
      total += sumFiles(item, filter);
    }
  }
  return total;
}

async function modelsBytes(): Promise<number> {
  try {
    if (!(await RNBlobUtil.fs.isDir(MODELS_DIR))) return 0;
    const items = await RNBlobUtil.fs.lstat(MODELS_DIR);
    return items.reduce((a, s) => a + (Number(s.size) || 0), 0);
  } catch {
    return 0;
  }
}

export interface StorageUsage {
  databaseBytes: number;
  modelsBytes: number;
  tempAudioBytes: number;
  benchmarkClipsBytes: number;
}

export async function measureStorage(): Promise<StorageUsage> {
  let databaseBytes = 0;
  for (const name of DB_FILE_NAMES) {
    try {
      const f = new File(Paths.document, 'SQLite', name);
      if (f.exists) databaseBytes += f.size ?? 0;
    } catch {
      // ignore
    }
  }
  let tempAudioBytes = 0;
  try {
    tempAudioBytes = sumFiles(Paths.cache, (n) => AUDIO_EXT.test(n));
  } catch {
    tempAudioBytes = 0;
  }
  let benchmarkClipsBytes = 0;
  try {
    benchmarkClipsBytes = sumFiles(new Directory(Paths.document, BENCHMARK_DIR));
  } catch {
    benchmarkClipsBytes = 0;
  }
  return { databaseBytes, modelsBytes: await modelsBytes(), tempAudioBytes, benchmarkClipsBytes };
}

/** Deletes every temporary audio file in the cache folder, including subfolders. */
export function deleteAllTempAudio(): void {
  const walk = (dir: Directory) => {
    if (!dir.exists) return;
    for (const item of dir.list()) {
      if (item instanceof File && AUDIO_EXT.test(item.name)) {
        try {
          item.delete();
        } catch {
          // ignore
        }
      } else if (item instanceof Directory) {
        walk(item);
      }
    }
  };
  try {
    walk(Paths.cache);
  } catch {
    // ignore
  }
}

export function deleteBenchmarkClips(): void {
  try {
    const dir = new Directory(Paths.document, BENCHMARK_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // ignore
  }
}

/** Deletes the downloaded Whisper and Qwen files. They download again on next launch. */
export async function deleteDownloadedModels(): Promise<void> {
  try {
    if (await RNBlobUtil.fs.isDir(MODELS_DIR)) await RNBlobUtil.fs.unlink(MODELS_DIR);
  } catch {
    // ignore
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
