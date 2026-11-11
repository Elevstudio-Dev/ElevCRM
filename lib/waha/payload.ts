/**
 * Leitores PUROS do payload de mensagem do WAHA (texto, tipo, mídia, nome de quem escreveu).
 *
 * Moravam em `ingest.ts`. Foram para cá quando a importação de histórico (`lib/waha/historico.ts`) precisou lê-los
 * sem puxar o módulo de ingestão inteiro — que importa o banco, o despachante da IA e o seam de canal, e fecharia
 * um ciclo (adapter → ingest → pos-entrada → canais). O `ingest.ts` os reexporta: quem importava de lá segue igual.
 */
import type { WahaPayload } from "./envelope";

/** URL da mídia: WAHA novo (payload.media.url) com fallback legado (payload.mediaUrl). */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.mediaUrl ?? p.media?.url ?? null;
}

/** MIME da mídia: idem (payload.media.mimetype é o campo do NOWEB atual). */
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.mimetype ?? p.media?.mimetype ?? null;
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

export function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * NOWEB (WAHA 2026.x) não envia `type` no payload — o tipo real está nas
 * chaves de `_data.message` (imageMessage, stickerMessage, …). Ordem de
 * resolução: `type` explícito → chave do message → prefixo do MIME → text.
 */
const NOWEB_MESSAGE_KEY_TYPE: Record<string, string> = {
  stickerMessage: "sticker",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video", // video note (bolinha)
  audioMessage: "audio",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  contactMessage: "contact",
};

export function resolveMessageType(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const msg = p._data?.message;
  if (msg && typeof msg === "object") {
    for (const [key, mapped] of Object.entries(NOWEB_MESSAGE_KEY_TYPE)) {
      if (key in msg) return mapped;
    }
  }
  const mime = mediaMimeOf(p);
  if (mime) {
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

export function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/** Corpo textual: WAHA nem sempre preenche `body` em cartões de contato NOWEB. */
export function bodyOf(p: WahaPayload): string | null {
  if (p.body) return p.body;
  const msg = p._data?.message;
  if (!msg || typeof msg !== "object") return null;
  // `_data.message` é `unknown` no schema Zod (`lib/waha/envelope.ts`), de
  // propósito: a forma NOWEB varia por tipo de mensagem e exigi-la aqui só
  // criaria uma porta nova de descartar a mensagem inteira. O estreitamento é
  // explícito, no mesmo estilo do `cm as {…}` logo abaixo.
  const cm = (msg as { contactMessage?: unknown }).contactMessage;
  if (cm && typeof cm === "object") {
    const o = cm as { vcard?: string; displayName?: string };
    if (o.vcard) return o.vcard;
    if (o.displayName) return o.displayName;
  }
  return null;
}
