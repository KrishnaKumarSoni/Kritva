/**
 * Epic 13: speech in and out, as a thin provider-neutral layer. Voice only supplies and delivers
 * messages: transcribed speech goes through the same text negotiation path, and only messages the
 * engine already recorded (and checked) are ever spoken. The voice layer never decides anything.
 */
import OpenAI, { toFile } from "openai";

export interface SpeechProvider {
  /** Speech to text for one completed utterance. */
  transcribe(audio: Uint8Array, mimeType: string, options?: { prompt?: string; signal?: AbortSignal }): Promise<{ text: string; ms: number; model: string }>;
  /** Text to speech for one recorded, checked message. Streams audio so playback can start early. */
  speak(text: string, options?: { signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; model: string }>;
}

export interface OpenAISpeechOptions {
  apiKey: string;
  transcribeModel: string;
  speechModel: string;
  voice: string;
  timeoutMs: number;
}

/** How Kritva sounds: warm and unhurried, per the humane conversation guide. */
const SPEAKING_STYLE =
  "Speak warmly and naturally, like a helpful person on a call. Relaxed, clear pace. Read amounts and place names clearly. No sales energy, no exaggerated enthusiasm.";

export class OpenAISpeech implements SpeechProvider {
  readonly #client: OpenAI;
  readonly #options: OpenAISpeechOptions;

  constructor(options: OpenAISpeechOptions) {
    this.#client = new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 0 });
    this.#options = options;
  }

  async transcribe(audio: Uint8Array, mimeType: string, options: { prompt?: string; signal?: AbortSignal } = {}) {
    const started = performance.now();
    const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("webm") ? "webm" : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "wav";
    const file = await toFile(Buffer.from(audio), `utterance.${extension}`, { type: mimeType });
    const result = await this.#client.audio.transcriptions.create(
      { file, model: this.#options.transcribeModel, ...(options.prompt ? { prompt: options.prompt } : {}) },
      { signal: options.signal },
    );
    return { text: (result as { text?: string }).text?.trim() ?? "", ms: Math.round(performance.now() - started), model: this.#options.transcribeModel };
  }

  async speak(text: string, options: { signal?: AbortSignal } = {}) {
    const response = await this.#client.audio.speech.create(
      { model: this.#options.speechModel, voice: this.#options.voice as never, input: text.slice(0, 4_000), instructions: SPEAKING_STYLE, response_format: "mp3" },
      { signal: options.signal },
    );
    if (!response.body) throw new Error("The speech service returned no audio.");
    return { body: response.body as ReadableStream<Uint8Array>, contentType: "audio/mpeg", model: this.#options.speechModel };
  }
}

export function createSpeechFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAISpeech | null {
  if (!env.OPENAI_API_KEY) return null;
  return new OpenAISpeech({
    apiKey: env.OPENAI_API_KEY,
    transcribeModel: env.KRITVA_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
    // The Speech API models are scheduled for retirement on 2027-01-06; set KRITVA_TTS_MODEL when migrating.
    speechModel: env.KRITVA_TTS_MODEL ?? "gpt-4o-mini-tts",
    voice: env.KRITVA_TTS_VOICE ?? "coral",
    timeoutMs: Number(env.KRITVA_VOICE_TIMEOUT_MS ?? 20_000),
  });
}
