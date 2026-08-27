import type { ModelConfig } from "./agent.js";

/** Realtime speech-to-speech providers that replace the whole STT+LLM+TTS pipeline with one model. */
export type VoiceRealtimeProvider = "openai" | "gemini" | "xai";

/**
 * Per-agent voice settings for meetings (`uc join --mode audio`). The "voice LLM" is either a normal
 * chat model (STT + LLM + TTS pipeline) or a realtime speech-to-speech model — if `realtime` is set,
 * STT/TTS are ignored (the model does it all) and only the voice matters.
 */
export interface VoiceConfig {
  /** Realtime S2S provider; when set, this replaces STT+LLM+TTS and `stt`/`tts` are ignored. */
  realtime?: VoiceRealtimeProvider | null;
  /** Voice LLM for the pipeline path. Absent/null = use the agent's text `model`. */
  llm?: ModelConfig | null;
  /** STT engine id: "whisper" | "voxtral" | "deepgram" | "openai" | … (pipeline only). Absent = auto-resolve. */
  stt?: string | null;
  /**
   * Catalog id of the specific transcription MODEL to use, e.g. "openai/gpt-transcribe" (see
   * SpeechModelInfo). The engine above is the adapter; this picks which of its models runs.
   *
   * Absent ⇒ the engine's built-in default, which is what happened before models were selectable. That
   * default is not always the best one: "openai" alone means `whisper-1`, the least accurate and most
   * expensive of OpenAI's six transcription models.
   */
  sttModel?: string | null;
  /** Catalog id of the specific TTS model, e.g. "elevenlabs/flash-v2.5". Absent ⇒ the engine's default. */
  ttsModel?: string | null;
  /** VAD (voice-activity detection) engine that segments speech before STT: "auto" | "silero" | "energy".
   *  Silero is a small local neural model (cleaner segmentation, far less silence-hallucination); energy
   *  is the built-in zero-dependency gate. Absent/"auto" ⇒ prefer the neural model when it can load. */
  vad?: string | null;
  /** TTS engine id: "say" | "piper" | "kokoro" | "elevenlabs" | "openai" (pipeline only). Absent = auto-resolve. */
  tts?: string | null;
  /** In a 1:1 meeting, reply to everything (true, the default) or stay silent until addressed by name
   *  as in a group (false). Groups always wait for the trigger word regardless of this. */
  always1on1?: boolean;
  /** Voice id/name — the TTS voice (pipeline) or the realtime model's voice. */
  voice?: string | null;
}

/** Languages the agent can be pinned to (ISO code + display name). Used by the Voice/Identity settings
 *  selector and to force the meeting STT + the agent's answer language. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" }, { code: "pt", name: "Portuguese" }, { code: "es", name: "Spanish" },
  { code: "fr", name: "French" }, { code: "de", name: "German" }, { code: "it", name: "Italian" },
  { code: "nl", name: "Dutch" }, { code: "pl", name: "Polish" }, { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" }, { code: "zh", name: "Chinese" }, { code: "ko", name: "Korean" },
  { code: "ar", name: "Arabic" }, { code: "hi", name: "Hindi" }, { code: "tr", name: "Turkish" },
  { code: "sv", name: "Swedish" }, { code: "ca", name: "Catalan" }, { code: "gl", name: "Galician" },
];

/** Human name for a language ISO code (falls back to the code itself). */
export function languageName(code?: string): string | undefined {
  if (!code) return undefined;
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** A selectable STT/TTS/realtime engine with live availability, for the Voice settings UI. */
export interface VoiceEngineInfo {
  id: string;
  label: string;
  kind: "stt" | "tts" | "realtime" | "vad";
  /** usable right now (local binary present or provider key in the vault) */
  available: boolean;
  local: boolean;
  /** short note: "installed", "needs OPENAI_API_KEY", … */
  detail: string;
  /** ISO language codes this engine supports. Absent = effectively all languages — the UI only gates
   *  engines that carry an explicit list (e.g. Parakeet's 25 European languages). */
  langs?: string[];
  /** Vault key that enables this engine — the store offers a secure "add key" modal for it. */
  keyName?: string;
  /** Id for POST /api/voice-models/:id/install when the engine is a local package. */
  installable?: string;
  /** One line to help CHOOSE between engines — tradeoffs, not status. */
  note?: string;
}

/** A selectable voice for an engine (id used by the engine, label shown to the user). */
export interface VoiceOption {
  id: string;
  label: string;
}

export interface VoiceOptions {
  stt: VoiceEngineInfo[];
  vad: VoiceEngineInfo[];
  tts: VoiceEngineInfo[];
  realtime: VoiceEngineInfo[];
}

/** A transcription engine the meeting-capture page can pick (only ones that can actually run here). */
export interface CaptureSttOption {
  id: string; // "whisper" | "parakeet" | "voxtral" | "openai" | "deepgram" | …
  label: string;
  local: boolean;
  available: boolean;
  detail: string;
  /** ISO language codes this engine supports. Absent = effectively all languages — pickers gate an
   *  engine out (with the reason) when the chosen spoken/agent language isn't in its list. */
  langs?: string[];
}

/** State for the meeting-capture transcription picker. */
export interface CaptureSttState {
  options: CaptureSttOption[];
  /** The saved default: an engine id, or "auto" (best available). */
  selected: string;
  /** What "auto" resolves to right now (null when nothing can transcribe). */
  auto: { id: string; label: string; local: boolean } | null;
  /** Real-time transcription: keep a persistent whisper-server loaded and stream interim (tentative)
   *  lines of the in-progress utterance, settled on each silence cut. Best with local Whisper. */
  realtime: boolean;
  /** Whisper ggml model sizes: the saved pick + every size with per-machine compatibility (too-big
   *  models are disabled with a reason). Models download on first use. */
  whisperModel: {
    selected: string;
    options: { id: string; label: string; sizeMB: number; downloaded: boolean; disabled?: boolean; reason?: string }[];
    /** What the transcriber is doing about the SELECTED model right now. A cold pick is a download, not
     *  a failure — but silence about it is what makes a recording look broken, so every surface reads
     *  this: the capture page's footer, its banner, and the gate on real-time transcription. */
    state: WhisperModelState;
  };
}

/** The transcription model's situation on the machine that records — see CaptureSttState.whisperModel. */
export interface WhisperModelState {
  selected: string;
  label: string;
  sizeMB: number;
  /** ready = on disk and usable · downloading = fetching now · absent = not here, not being fetched ·
   *  error = the last attempt failed (`error` carries the reason verbatim). */
  phase: "ready" | "downloading" | "absent" | "error";
  receivedBytes?: number;
  totalBytes?: number;
  pct?: number;
  error?: string;
  /** A compatible model already on disk that transcribes MEANWHILE, so a cold pick never costs a
   *  meeting its words — only some accuracy, and only until the chosen weights land. */
  fallback?: string;
  fallbackLabel?: string;
}

/** A speech model (STT/TTS) surfaced in the media store — these live in the voice subsystem, so the
 *  store shows their status and how to enable them rather than installing them itself. */
export interface VoiceModelInfo {
  id: string;
  /** "realtime" is speech-to-speech (Grok, OpenAI Realtime, Gemini Live) — it replaces STT+LLM+TTS. */
  kind: "stt" | "tts" | "realtime";
  label: string;
  local: boolean;
  available: boolean;
  /** Status / how to enable, e.g. "installed · local · offline" or "needs OPENAI_API_KEY". */
  detail: string;
  /** Vault key that would enable it — drives the store's secure "add key" modal. */
  keyName?: string;
  /** Local package the store can install in one click. */
  installable?: string;
  /** ISO codes this engine transcribes. Absent = effectively unrestricted. */
  langs?: string[];
  /** One line to help choose between engines. */
  note?: string;
}

/**
 * One speech model in the model store: a transcription, text-to-speech or speech-to-speech model from
 * any supplier, with everything needed to COMPARE it against the others on one screen.
 *
 * `VoiceModelInfo` (above) describes an ENGINE — the adapter, and whether it's usable. This describes a
 * MODEL — what it costs, how accurate it is, how fast, and what it can do. An engine like "openai" has
 * six transcription models behind it at four different prices; before this type the UI could only offer
 * the engine, so it always got whichever one the code happened to hardcode.
 */
export interface SpeechModelInfo {
  /** Catalog id, `provider/model` — the value saved in an agent's voice config. */
  id: string;
  kind: "stt" | "tts" | "realtime";
  provider: string;
  label: string;
  /** The adapter that runs it. Absent ⇒ browse-only (listed for comparison, not offered as a pick). */
  engine?: string;
  /** The id sent on the wire. */
  modelId?: string;
  local: boolean;
  available: boolean;
  /** Available AND routable. The picker offers only these; the store lists everything. */
  selectable: boolean;
  /** USD per minute of audio, normalized from whatever unit the supplier quotes — the sort column. */
  perMinuteNormalized?: number;
  /** The supplier's own quote ("$50/1M chars"), so a normalized number can be explained. */
  priceUnitLabel: string;
  /** What the price assumes (tier, streaming vs batch). */
  priceNote?: string;
  /** Word error rate %, LOWER IS BETTER. One independent harness for all of them, so they're comparable. */
  wer?: number;
  /** Batch throughput as a multiple of real time. */
  speed?: number;
  /** Time to first audio / first token, ms. */
  latencyMs?: number;
  languages?: number;
  streaming?: boolean;
  diarization?: boolean;
  timestamps?: boolean;
  cloning?: boolean;
  offline?: boolean;
  license?: string;
  note?: string;
  homepage?: string;
  /** Vault keys that would unlock it (any one is enough) — drives the store's "add key" modal. */
  unlockKeys?: string[];
  /** Local package the store can install in one click. */
  installable?: string;
  /** Why it isn't usable yet, phrased as the action that fixes it. */
  hint?: string;
}

export interface SpeechModelsResponse {
  models: SpeechModelInfo[];
  /** When these prices were last checked against the suppliers — so a stale catalog reads as stale. */
  pricesChecked: string;
  /** Characters of speech per minute used to convert a $/1M-chars TTS quote into $/min. */
  charsPerMinute: number;
  /** Where the numbers came from, cited in the UI rather than buried in a commit. */
  sources: { label: string; url: string }[];
}
