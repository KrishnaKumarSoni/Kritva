/**
 * Browser voice for one buyer session (Epic 13). This file only moves audio:
 * - listens with voice-activity detection and sends each completed utterance (16 kHz WAV) to the
 *   server, which transcribes it and runs the normal text negotiation path;
 * - plays Kritva's recorded, checked replies, streamed from the server;
 * - stops playback when the buyer talks over it, and reports what was actually heard.
 * It never decides what Kritva says. No phone call is placed and no credentials reach the browser.
 */

export type VoiceState = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "muted" | "interrupted" | "ended" | "error";

export interface VoiceCallbacks {
  onState: (state: VoiceState) => void;
  /** A completed utterance, ready to send. `endedAt` is when the buyer stopped speaking. */
  onUtterance: (wav: Blob, endedAt: number) => void;
  /** The buyer talked over a reply: what was heard before it stopped. */
  onInterrupted: (messageId: string, heardText: string, audioStartMs: number | null) => void;
  onPlayed: (messageId: string, audioStartMs: number | null) => void;
  onPlaybackFailed: (messageId: string) => void;
  onDisconnected: () => void;
  onError: (message: string) => void;
}

const FRAME = 2048;
const TARGET_RATE = 16_000;
const PREROLL_FRAMES = 6;

export class VoiceSession {
  #stream: MediaStream | null = null;
  #ctx: AudioContext | null = null;
  #processor: ScriptProcessorNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #cb: VoiceCallbacks;
  #state: VoiceState = "idle";
  #muted = false;
  #floor = 0;
  #calibrating = 0;
  #loud = 0;
  #quiet = 0;
  #preroll: Float32Array[] = [];
  #capture: Float32Array[] | null = null;
  #rate = 48_000;
  #audio: HTMLAudioElement | null = null;
  #playing: { messageId: string; text: string; audioStartMs: number | null; finish: () => void } | null = null;
  #lastUtteranceEnd: number | null = null;
  #busy = false;

  constructor(callbacks: VoiceCallbacks) {
    this.#cb = callbacks;
  }

  get state(): VoiceState {
    return this.#state;
  }

  #set(state: VoiceState) {
    this.#state = state;
    this.#cb.onState(state);
  }

  /** Asks for the microphone as part of the start action. Calling it twice does nothing. */
  async start(): Promise<boolean> {
    if (this.#state !== "idle" && this.#state !== "ended" && this.#state !== "error") return false;
    this.#set("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (!this.#isConnecting()) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.#stream = stream;
      for (const track of stream.getAudioTracks()) track.onended = () => this.#cb.onDisconnected();
      this.#ctx = new AudioContext();
      this.#rate = this.#ctx.sampleRate;
      this.#source = this.#ctx.createMediaStreamSource(stream);
      this.#processor = this.#ctx.createScriptProcessor(FRAME, 1, 1);
      this.#processor.onaudioprocess = (e) => this.#frame(e.inputBuffer.getChannelData(0));
      this.#source.connect(this.#processor);
      this.#processor.connect(this.#ctx.destination);
      this.#calibrating = 8;
      this.#floor = 0;
      this.#busy = true;
      this.#ctx.resume().catch(() => this.#cb.onDisconnected());
      return true;
    } catch (error) {
      if (!this.#isConnecting()) return false;
      this.end();
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.#cb.onError(!window.isSecureContext ? "Microphone access requires HTTPS or localhost." : denied ? "Microphone access was blocked. Allow it in the browser's address bar, then try again." : "No microphone could be opened. Check that one is connected, then try again.");
      this.#set("error");
      return false;
    }
  }

  #isConnecting() { return this.#state === "connecting"; }

  setMuted(muted: boolean) {
    this.#muted = muted;
    this.#stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (muted) {
      this.#capture = null;
      this.#loud = 0;
    }
    this.#preroll = [];
    if (muted || this.#state === "muted") this.#set(muted ? "muted" : this.#playing ? "speaking" : this.#busy ? "thinking" : "listening");
  }

  /** While a request is in flight the buyer's turn is being processed. */
  setBusy(busy: boolean) {
    this.#busy = busy;
    if (busy && !this.#playing) this.#set("thinking");
    else if (!busy && !this.#playing && (this.#state === "thinking" || this.#isConnecting())) this.#set(this.#muted ? "muted" : "listening");
  }

  /** Plays one recorded reply. Resolves when it finishes, is interrupted, or fails. */
  play(messageId: string, text: string, url: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      this.#audio = audio;
      const speechEndedAt = this.#lastUtteranceEnd;
      this.#lastUtteranceEnd = null;
      const done = () => {
        audio.onended = audio.onerror = audio.onplaying = null;
        if (this.#audio === audio) this.#audio = null;
        if (this.#playing?.messageId === messageId) this.#playing = null;
        if (this.#state === "speaking" || this.#state === "thinking") this.#set(this.#muted ? "muted" : this.#busy ? "thinking" : "listening");
        resolve();
      };
      const playback = { messageId, text, audioStartMs: null as number | null, finish: done };
      this.#playing = playback;
      audio.onplaying = () => {
        if (speechEndedAt !== null) playback.audioStartMs ??= Math.round(performance.now() - speechEndedAt);
        if (!this.#muted) this.#set("speaking");
      };
      audio.onended = () => {
        this.#cb.onPlayed(messageId, playback.audioStartMs);
        done();
      };
      const failed = () => {
        if (this.#audio !== audio) return;
        this.#cb.onError("Kritva's voice couldn't play. The reply is shown in the chat.");
        this.#cb.onPlaybackFailed(messageId);
        done();
      };
      audio.onerror = failed;
      audio.play().catch(failed);
    });
  }

  /** Stops the current reply and reports how much of it was heard. */
  interrupt() {
    const audio = this.#audio;
    const playing = this.#playing;
    if (!audio || !playing) return;
    const fraction = audio.duration && Number.isFinite(audio.duration) ? Math.min(1, audio.currentTime / audio.duration) : 0;
    audio.pause();
    this.#cb.onInterrupted(playing.messageId, heardPart(playing.text, fraction), playing.audioStartMs);
    playing.finish();
    audio.removeAttribute("src");
    audio.load();
    this.#set(this.#muted ? "muted" : "interrupted");
  }

  /** Stops input and output. What was playing counts as interrupted, never as delivered. */
  end() {
    if (this.#playing) this.interrupt();
    this.#processor?.disconnect();
    this.#source?.disconnect();
    this.#stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.#ctx?.close().catch(() => undefined);
    this.#processor = null;
    this.#source = null;
    this.#stream = null;
    this.#ctx = null;
    this.#capture = null;
    this.#set("ended");
  }

  #frame(input: Float32Array) {
    const frame = new Float32Array(input);
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / frame.length);
    if (this.#calibrating > 0) {
      this.#floor = this.#floor === 0 ? rms : this.#floor * 0.7 + rms * 0.3;
      this.#calibrating -= 1;
      return;
    }
    if (this.#muted) return;
    const threshold = Math.max(0.012, this.#floor * 3);
    const speaking = this.#playing !== null;
    // While Kritva talks, only a clearly louder voice counts, so its own audio doesn't cut itself off.
    const loud = rms > (speaking ? threshold * 2.2 : threshold);

    if (this.#capture) {
      this.#capture.push(frame);
      this.#quiet = loud ? 0 : this.#quiet + 1;
      const seconds = (this.#capture.length * FRAME) / this.#rate;
      if (this.#quiet * FRAME >= this.#rate * 0.6 || seconds > 25) this.#finish();
      return;
    }
    this.#preroll.push(frame);
    if (this.#preroll.length > PREROLL_FRAMES) this.#preroll.shift();
    if (!loud) {
      this.#loud = 0;
      if (!speaking) this.#floor = this.#floor * 0.98 + rms * 0.02;
      return;
    }
    this.#loud += 1;
    if (this.#loud >= (speaking ? 3 : 2)) {
      if (speaking) this.interrupt();
      if (this.#busy) return;
      this.#capture = [...this.#preroll];
      this.#preroll = [];
      this.#quiet = 0;
      this.#set("hearing");
    }
  }

  #finish() {
    const frames = this.#capture ?? [];
    this.#capture = null;
    this.#loud = 0;
    const seconds = (frames.length * FRAME) / this.#rate;
    if (seconds < 0.5) {
      this.#set(this.#muted ? "muted" : "listening");
      return;
    }
    const endedAt = performance.now() - (this.#quiet * FRAME * 1000) / this.#rate;
    this.#lastUtteranceEnd = endedAt;
    this.#cb.onUtterance(encodeWav(frames, this.#rate, TARGET_RATE), endedAt);
  }
}

/** The words of a reply that were heard before playback stopped, cut at a word boundary. */
export function heardPart(text: string, fraction: number): string {
  if (fraction <= 0) return "";
  if (fraction >= 0.98) return text;
  const cut = Math.floor(text.length * fraction);
  const space = text.lastIndexOf(" ", cut);
  return text.slice(0, space > 0 ? space : cut).trim();
}

/** Mono 16-bit PCM WAV, downsampled by averaging. */
function encodeWav(frames: Float32Array[], fromRate: number, toRate: number): Blob {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    joined.set(f, offset);
    offset += f.length;
  }
  const ratio = fromRate / toRate;
  const length = Math.floor(total / ratio);
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let acc = 0;
    for (let j = start; j < end; j += 1) acc += joined[j]!;
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const write = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, toRate, true);
  view.setUint32(28, toRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}
