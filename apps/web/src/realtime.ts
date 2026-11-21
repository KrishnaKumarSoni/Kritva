/**
 * Live voice for one buyer session (docs/Kritva_Realtime_Voice.md). This file only connects audio:
 * - sends the microphone to OpenAI's realtime model over WebRTC, through Kritva's server, which
 *   creates the call and handles every tool call (no credentials reach the browser);
 * - plays Kritva's voice from the call;
 * - reports, for each recorded reply, whether its audio finished or was cut off, so a half-heard
 *   offer never counts as delivered.
 * It never decides what Kritva says.
 */
import { heardPart, type VoiceState } from "./voice.ts";

export interface RealtimeCallbacks {
  onState: (state: VoiceState) => void;
  /** What the buyer said, as transcribed. */
  onHeard: (transcript: string) => void;
  /** A recorded reply finished playing, or was cut off (with the approximate part heard). */
  onDelivery: (messageId: string, status: "delivered" | "interrupted", heardText: string | null, audioStartMs: number | null) => void;
  onDisconnected: () => void;
  onError: (message: string) => void;
  /** Something was said or recorded: the page should reload the conversation. */
  onActivity: () => void;
}

/** Characters spoken per second, for estimating how much of a cut-off reply was heard. */
const SPEAKING_RATE = 14;

export class UnavailableError extends Error {}

export class RealtimeVoice {
  #cb: RealtimeCallbacks;
  #pc: RTCPeerConnection | null = null;
  #channel: RTCDataChannel | null = null;
  #stream: MediaStream | null = null;
  #audio: HTMLAudioElement | null = null;
  #state: VoiceState = "idle";
  #muted = false;
  /** Response ID → the recorded message it speaks. */
  #messages = new Map<string, string>();
  #texts = new Map<string, string>();
  #playing: { responseId: string; startedAt: number; audioStartMs: number | null } | null = null;
  #speechStoppedAt: number | null = null;

  constructor(callbacks: RealtimeCallbacks) {
    this.#cb = callbacks;
  }

  get state() {
    return this.#state;
  }

  #set(state: VoiceState) {
    this.#state = state;
    this.#cb.onState(state);
  }

  /** The text of each recorded message, so a cut-off reply's heard part can be estimated. */
  know(messageId: string, text: string) {
    this.#texts.set(messageId, text);
  }

  /** Asks for the microphone and connects the call. Throws UnavailableError when live voice is off. */
  async start(connect: (sdp: string) => Promise<string>): Promise<boolean> {
    if (this.#state !== "idle" && this.#state !== "ended" && this.#state !== "error") return false;
    this.#set("connecting");
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (error) {
      this.end();
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.#cb.onError(!window.isSecureContext ? "Microphone access requires HTTPS or localhost." : denied ? "Microphone access was blocked. Allow it in the browser's address bar, then try again." : "No microphone could be opened. Check that one is connected, then try again.");
      this.#set("error");
      return false;
    }
    if (!this.#connecting()) {
      this.#stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const pc = new RTCPeerConnection();
    this.#pc = pc;
    const audio = new Audio();
    audio.autoplay = true;
    this.#audio = audio;
    pc.ontrack = (e) => (audio.srcObject = e.streams[0] ?? null);
    for (const track of this.#stream.getAudioTracks()) {
      pc.addTrack(track, this.#stream);
      track.onended = () => this.#cb.onDisconnected();
    }
    const channel = pc.createDataChannel("oai-events");
    this.#channel = channel;
    channel.onmessage = (m) => {
      try {
        this.#event(JSON.parse(String(m.data)) as { type: string } & Record<string, any>);
      } catch {
        /* ignore malformed events */
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.#cb.onDisconnected();
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await connect(offer.sdp ?? "");
      if (this.#pc !== pc) return false;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      this.end();
      if (error instanceof UnavailableError) throw error;
      this.#cb.onError(error instanceof Error && error.message ? error.message : "Voice couldn't connect. You can keep typing.");
      this.#set("error");
      return false;
    }
    this.#set(this.#muted ? "muted" : "listening");
    return true;
  }

  /** Read through a method so the check sees state changed while awaiting the microphone. */
  #connecting() {
    return this.#state === "connecting";
  }

  #event(e: { type: string } & Record<string, any>) {
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        if (!this.#muted) this.#set("hearing");
        return;
      case "input_audio_buffer.speech_stopped":
        this.#speechStoppedAt = performance.now();
        if (!this.#muted) this.#set("thinking");
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof e.transcript === "string" && e.transcript.trim()) this.#cb.onHeard(e.transcript.trim());
        this.#cb.onActivity();
        return;
      case "response.done":
        this.#cb.onActivity();
        return;
      case "response.created": {
        const messageId = e.response?.metadata?.message_id;
        if (e.response?.id && typeof messageId === "string") this.#messages.set(e.response.id, messageId);
        return;
      }
      case "output_audio_buffer.started": {
        const audioStartMs = this.#speechStoppedAt === null ? null : Math.round(performance.now() - this.#speechStoppedAt);
        this.#speechStoppedAt = null;
        this.#playing = { responseId: String(e.response_id ?? ""), startedAt: performance.now(), audioStartMs };
        if (!this.#muted) this.#set("speaking");
        this.#cb.onActivity();
        return;
      }
      case "output_audio_buffer.stopped":
        this.#finish("delivered");
        return;
      case "output_audio_buffer.cleared":
        this.#finish("interrupted");
        return;
      default:
        return;
    }
  }

  #finish(status: "delivered" | "interrupted") {
    const playing = this.#playing;
    this.#playing = null;
    this.#cb.onActivity();
    if (this.#state === "speaking") this.#set(this.#muted ? "muted" : status === "interrupted" ? "interrupted" : "listening");
    if (!playing) return;
    const messageId = this.#messages.get(playing.responseId);
    if (!messageId) return;
    this.#messages.delete(playing.responseId);
    const text = this.#texts.get(messageId) ?? "";
    const heard = status === "interrupted" ? heardPart(text, ((performance.now() - playing.startedAt) / 1000) * SPEAKING_RATE / Math.max(1, text.length)) : null;
    this.#cb.onDelivery(messageId, status, heard, playing.audioStartMs);
  }

  setMuted(muted: boolean) {
    this.#muted = muted;
    this.#stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (this.#state !== "connecting" && this.#state !== "ended" && this.#state !== "error") this.#set(muted ? "muted" : "listening");
  }

  /** Stops the call. A reply still playing counts as interrupted, never as delivered. */
  end() {
    if (this.#playing) this.#finish("interrupted");
    this.#channel?.close();
    this.#pc?.getSenders().forEach((s) => s.track?.stop());
    this.#pc?.close();
    this.#stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    if (this.#audio) this.#audio.srcObject = null;
    this.#pc = null;
    this.#channel = null;
    this.#stream = null;
    this.#audio = null;
    this.#set("ended");
  }
}
