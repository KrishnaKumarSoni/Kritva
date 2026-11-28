/**
 * Sarvam AI speech for phone calls on Vobiz (docs/Kritva_Phone_Calls.md, section 17): Saaras turns a
 * caller's words into text, and Bulbul speaks Kritva's replies in an Indian voice. Sarvam only hears
 * and speaks: what Kritva says is always the negotiation engine's recorded, checked text.
 * https://docs.sarvam.ai/api-reference-docs
 */
import { concat, stripWav, wav16 } from "./audio.ts";

export interface SarvamSettings {
  apiKey: string;
  /** Speech to text: "saaras:v3" (default) or "saarika:v2.5". */
  sttModel: string;
  /** Text to speech: "bulbul:v3" (default) or "bulbul:v4-flash" (which needs persona speakers). */
  ttsModel: string;
  /** Bulbul voice. "simran" (default): a woman's voice that speaks every supported language. */
  speaker: string;
  /** Speaking pace, 0.5 to 2. */
  pace: number;
}

export function sarvamFromEnv(env: NodeJS.ProcessEnv = process.env): SarvamSettings | null {
  const apiKey = env.SARVAM_API_KEY?.trim();
  if (!apiKey) return null;
  const pace = Number(env.KRITVA_SARVAM_PACE);
  return {
    apiKey,
    sttModel: env.KRITVA_SARVAM_STT_MODEL?.trim() || "saaras:v3",
    ttsModel: env.KRITVA_SARVAM_TTS_MODEL?.trim() || "bulbul:v3",
    speaker: env.KRITVA_SARVAM_SPEAKER?.trim() || "simran",
    pace: Number.isFinite(pace) && pace >= 0.5 && pace <= 2 ? pace : 1,
  };
}

/** What a call needs from speech: hear an utterance, speak a line. Tests pass a fake. */
export interface PhoneSpeech {
  /** Text of one utterance (16-bit mono PCM) and the language it was spoken in (ISO 639-1), if known. With a language, it is heard as that language. */
  transcribe(pcm: Uint8Array, sampleRate: number, language?: string): Promise<{ text: string; language: string | null }>;
  /** Raw 16-bit mono PCM of the text, spoken in the language (ISO 639-1), at the sample rate. */
  speak(text: string, language: string, sampleRate: number): Promise<Uint8Array>;
}

const LANGUAGES = new Set(["en", "hi", "bn", "ta", "te", "gu", "kn", "ml", "mr", "pa", "od"]);

export class SarvamSpeech implements PhoneSpeech {
  readonly #s: SarvamSettings;
  readonly #base: string;

  constructor(settings: SarvamSettings, base = "https://api.sarvam.ai") {
    this.#s = settings;
    this.#base = base;
  }

  async transcribe(pcm: Uint8Array, sampleRate: number, language?: string) {
    const form = new FormData();
    form.set("file", new Blob([wav16(pcm, sampleRate) as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "utterance.wav");
    form.set("model", this.#s.sttModel);
    // "unknown" detects the language per utterance, so a caller can switch between Hindi and English freely.
    form.set("language_code", language && LANGUAGES.has(language) ? `${language}-IN` : "unknown");
    if (this.#s.sttModel.startsWith("saaras")) form.set("mode", "codemix");
    const res = await fetch(`${this.#base}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": this.#s.apiKey }, body: form, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as { transcript?: string; language_code?: string | null; error?: { message?: string } };
    if (!res.ok) throw new Error(`Sarvam speech-to-text failed (${res.status}): ${body.error?.message?.slice(0, 200) ?? ""}`);
    const detected = body.language_code?.split("-")[0]?.toLowerCase() ?? null;
    return { text: (body.transcript ?? "").trim(), language: detected && LANGUAGES.has(detected) ? detected : null };
  }

  async speak(text: string, language: string, sampleRate: number) {
    const res = await fetch(`${this.#base}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": this.#s.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        target_language_code: `${LANGUAGES.has(language) ? language : "en"}-IN`,
        model: this.#s.ttsModel,
        speaker: this.#s.speaker,
        pace: this.#s.pace,
        speech_sample_rate: sampleRate,
        output_audio_codec: "linear16",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { audios?: string[]; error?: { message?: string } };
    if (!res.ok || !body.audios?.length) throw new Error(`Sarvam text-to-speech failed (${res.status}): ${body.error?.message?.slice(0, 200) ?? "no audio"}`);
    // Each piece is decoded on its own: joined base64 strings would break at a piece's padding.
    return concat(body.audios.map((piece) => stripWav(new Uint8Array(Buffer.from(piece, "base64")))));
  }
}
