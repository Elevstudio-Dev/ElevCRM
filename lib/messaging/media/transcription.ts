/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
import type { RotaDeTranscricao } from "@/lib/messaging/media/rota-de-transcricao";

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Cabeçalhos extras (a atribuição opcional da OpenRouter). */
  headers?: Record<string, string>;
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

/**
 * A OpenRouter atende o mesmo formato em `/api/v1/audio/transcriptions`. O
 * cliente abaixo acrescenta `/v1/audio/transcriptions` à base, então a base
 * dela termina em `/api` — e não em `/api/v1`, que daria `/v1/v1/…`.
 *
 * O modelo é o mesmo Whisper que a rota direta usa, só com o nome no formato
 * `fabricante/modelo` que a OpenRouter exige.
 */
export const OPENROUTER_TRANSCRIPTION_BASE = "https://openrouter.ai/api";
export const OPENROUTER_TRANSCRIPTION_MODEL = "openai/whisper-1";

/** O transcritor de cada rota, com o endereço e o modelo que ela pede. */
export function transcritorDaRota(
  rota: RotaDeTranscricao,
  opcoes: { headers?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): TranscriptionProvider {
  if (rota.via === "openrouter") {
    return apiTranscriptionProvider(
      {
        apiKey: rota.apiKey,
        baseUrl: OPENROUTER_TRANSCRIPTION_BASE,
        model: OPENROUTER_TRANSCRIPTION_MODEL,
        headers: opcoes.headers,
      },
      opcoes.fetchImpl,
    );
  }
  return apiTranscriptionProvider({ apiKey: rota.apiKey }, opcoes.fetchImpl);
}

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const base = creds.baseUrl ?? DEFAULT_BASE;
  const model = creds.model ?? DEFAULT_MODEL;
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("model", model);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { ...creds.headers, Authorization: `Bearer ${creds.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
