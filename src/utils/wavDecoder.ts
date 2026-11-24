/**
 * Lightweight pure-TypeScript WAV audio decoder.
 * Converts 16-bit PCM or 32-bit Float WAV audio bytes into a 16 kHz mono Float32Array
 * required by Whisper STT.
 */

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export function decodeWavBytes(bytes: Uint8Array): DecodedWav {
  if (!bytes || bytes.length < 44) {
    return {
      samples: new Float32Array(0),
      sampleRate: 16000,
      channels: 1,
      durationMs: 0,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check RIFF header: "RIFF"
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file: missing RIFF/WAVE header');
  }

  let offset = 12;
  let audioFormat = 1; // 1 = PCM, 3 = IEEE Float
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataLength = 0;

  // Search chunks
  while (offset < bytes.length - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === 0 || dataLength === 0) {
    return {
      samples: new Float32Array(0),
      sampleRate,
      channels: numChannels,
      durationMs: 0,
    };
  }

  // Extract samples
  const bytesPerSample = bitsPerSample / 8;
  const totalRawSamples = Math.floor(dataLength / bytesPerSample);
  const frames = Math.floor(totalRawSamples / numChannels);

  const monoSamples = new Float32Array(frames);

  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleByteOffset = dataOffset + (i * numChannels + ch) * 2;
        const s16 = view.getInt16(sampleByteOffset, true);
        sum += s16 / 32768.0;
      }
      monoSamples[i] = sum / numChannels;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleByteOffset = dataOffset + (i * numChannels + ch) * 4;
        const f32 = view.getFloat32(sampleByteOffset, true);
        sum += f32;
      }
      monoSamples[i] = sum / numChannels;
    }
  } else {
    // Basic fallback for 8-bit PCM
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const s8 = view.getUint8(dataOffset + i * numChannels + ch);
        sum += (s8 - 128) / 128.0;
      }
      monoSamples[i] = sum / numChannels;
    }
  }

  // Resample to 16,000 Hz if needed
  let finalSamples = monoSamples;
  const targetRate = 16000;
  if (sampleRate !== targetRate && frames > 0) {
    const ratio = sampleRate / targetRate;
    const targetFrames = Math.round(frames / ratio);
    finalSamples = new Float32Array(targetFrames);

    for (let i = 0; i < targetFrames; i++) {
      const srcPos = i * ratio;
      const index = Math.floor(srcPos);
      const frac = srcPos - index;
      const s0 = monoSamples[index] ?? 0;
      const s1 = monoSamples[Math.min(index + 1, frames - 1)] ?? s0;
      finalSamples[i] = s0 + frac * (s1 - s0);
    }
  }

  const durationMs = Math.round((finalSamples.length / targetRate) * 1000);

  return {
    samples: finalSamples,
    sampleRate: targetRate,
    channels: 1,
    durationMs,
  };
}

