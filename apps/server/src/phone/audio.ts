/**
 * Small audio helpers for phone calls carried as raw 16-bit PCM (Vobiz media streams, Sarvam speech):
 * base64, loudness, WAV wrapping, and splitting a reply into sentences to speak one at a time.
 * Everything is mono, little-endian, 16-bit.
 */

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** Root-mean-square loudness of 16-bit PCM (0 to 32768). Speech on a phone line is roughly 500 to 5000. */
export function rms16(pcm: Uint8Array): number {
  const samples = pcm.byteLength >> 1;
  if (!samples) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** Milliseconds of 16-bit mono PCM at a sample rate. */
export const pcmMs = (bytes: number, sampleRate: number): number => (bytes / 2 / sampleRate) * 1000;

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** 16-bit mono PCM in a WAV container, for a speech-to-text upload. */
export function wav16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => header.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  return concat([new Uint8Array(header.buffer), pcm]);
}

/** The raw samples of a WAV file (its "data" chunk), or the bytes unchanged when they are not WAV. */
export function stripWav(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return bytes.subarray(at + 8, Math.min(bytes.byteLength, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return bytes.subarray(44);
}

/**
 * A reply split into sentences, so the first one can play while the rest is synthesised. Short
 * pieces join the next one; the Devanagari danda (।) ends a sentence too.
 */
export function sentences(text: string, minChars = 24): string[] {
  const parts = text.match(/[^.!?।॥]+(?:[.!?।॥]+["')\]]*\s*|$)/gu)?.map((p) => p.trim()).filter(Boolean) ?? [text.trim()];
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && out.at(-1)!.length < minChars) out[out.length - 1] = `${out.at(-1)} ${part}`;
    else out.push(part);
  }
  return out.filter(Boolean);
}
