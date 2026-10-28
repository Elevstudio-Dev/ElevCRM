/**
 * Encaminhar mensagens de uma conversa para outras (até 5).
 *
 * Cada cópia sai pelo MESMO caminho de qualquer mensagem do atendente (`sendMessageHandler`) — e por isso
 * herda o que ele já cobra: contato bloqueado, posse da mídia, o canal e o que o provider recusar. Este
 * arquivo só decide O QUE vai (`lib/messaging/encaminhar.ts`), copia o arquivo para a conversa de destino e
 * conta o que saiu.
 *
 * ─── Por que o arquivo é COPIADO ────────────────────────────────────────────
 *
 * `sendMessageHandler` só aceita mídia que mora sob `{org}/{conversa-de-destino}/` (a posse do objeto é
 * checada ali, e é o que impede um atendente de mandar o arquivo de outra conversa por um caminho
 * inventado). O arquivo encaminhado mora na conversa de ORIGEM — então se COPIA para a de destino, com
 * nome novo, em vez de afrouxar essa checagem.
 *
 * ─── O que fica gravado ─────────────────────────────────────────────────────
 *
 * Uma linha de auditoria por encaminhamento (quem, de qual conversa, para quais, quantas saíram) — SEM o
 * conteúdo: num CRM de clínica o que se encaminha é dado de uma pessoa chegando ao WhatsApp de outra, e a
 * trilha precisa dizer que aconteceu sem virar uma segunda cópia do dado.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import {
  metadataDoEncaminhamento,
  podeEncaminhar,
  TEXTO_DO_MOTIVO,
  validarPedido,
} from "@/lib/messaging/encaminhar";
import { extFromMime } from "@/lib/messaging/media/types";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import type { ForwardMessagesInput, SendMessageInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

type SB = SupabaseClient;

const BUCKET = "whatsapp-media";

interface Origem {
  id: string;
  organization_id: string;
  conversation_id: string;
  type: string;
  direction: string;
  status: string;
  body: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  media_url: string | null;
  revoked_at: string | null;
  sent_at: string;
}

interface Destino {
  id: string;
  status: string;
  contacts: { name: string | null; is_blocked: boolean } | null;
}

export interface ResultadoDoDestino {
  conversation_id: string;
  contato: string | null;
  enviadas: number;
  falhas: { message_id: string; erro: string }[];
}

export interface ResultadoDoEncaminhamento {
  destinos: ResultadoDoDestino[];
  total_enviadas: number;
  total_falhas: number;
}

function textoDoErro(err: unknown): string {
  if (err instanceof ApiError) return err.message || err.code;
  return err instanceof Error ? err.message : "erro inesperado";
}

export async function forwardMessagesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: ForwardMessagesInput,
): Promise<ResultadoDoEncaminhamento> {
  const pedido = validarPedido(input.message_ids, input.destination_conversation_ids);
  if (!pedido.ok) {
    throw new ApiError(422, "validation_failed", undefined, ctx.requestId, pedido.mensagem);
  }

  // ─── 1. As mensagens de origem — pelo cliente do USUÁRIO (RLS): só se encaminha o que se enxerga ───
  const { data: origensBrutas, error: origemErr } = await supabase
    .from("messages")
    .select(
      "id, organization_id, conversation_id, type, direction, status, body, media_mime, media_size_bytes, media_storage_path, media_url, revoked_at, sent_at",
    )
    .in("id", input.message_ids)
    .eq("organization_id", ctx.organization_id);
  if (origemErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, origemErr.message);

  const origens = (origensBrutas ?? []) as unknown as Origem[];
  // Faltou alguma: fora do acesso ou inexistente — a mesma resposta, para não dizer qual.
  if (origens.length !== input.message_ids.length) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Mensagem não encontrada.");
  }
  const conversasDeOrigem = new Set(origens.map((o) => o.conversation_id));
  if (conversasDeOrigem.size !== 1) {
    throw new ApiError(
      422,
      "validation_failed",
      undefined,
      ctx.requestId,
      "As mensagens precisam ser da mesma conversa.",
    );
  }
  const conversaDeOrigemId = origens[0]!.conversation_id;

  // Nada sai se UMA das mensagens não pode ir: o atendente escolheu um conjunto, e mandar só um pedaço
  // dele (sem avisar qual ficou de fora) é pior que recusar.
  for (const o of origens) {
    const r = podeEncaminhar(o);
    if (!r.ok) {
      throw new ApiError(422, "not_forwardable", undefined, ctx.requestId, TEXTO_DO_MOTIVO[r.motivo]);
    }
  }
  // Na ordem em que foram ditas.
  origens.sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));

  // ─── 2. As conversas de destino — também pelo cliente do USUÁRIO ───
  const { data: destinosBrutos, error: destinoErr } = await supabase
    .from("conversations")
    .select("id, status, contacts:contact_id(name, is_blocked)")
    .in("id", input.destination_conversation_ids)
    .eq("organization_id", ctx.organization_id);
  if (destinoErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, destinoErr.message);

  const destinos = (destinosBrutos ?? []) as unknown as Destino[];
  if (destinos.length !== input.destination_conversation_ids.length) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa de destino não encontrada.");
  }
  // Mantém a ordem em que o atendente os escolheu.
  const porId = new Map(destinos.map((d) => [d.id, d]));

  const admin = createAdminClient();

  /** Manda TODAS as mensagens para UM destino, em ordem. Falha numa não derruba as outras. */
  const paraUmDestino = async (destinoId: string): Promise<ResultadoDoDestino> => {
    const d = porId.get(destinoId)!;
    const resultado: ResultadoDoDestino = {
      conversation_id: destinoId,
      contato: d.contacts?.name ?? null,
      enviadas: 0,
      falhas: [],
    };

    // A tela barra o campo de envio numa conversa fechada; encaminhar para uma é a mesma coisa por outra
    // porta, e a regra não pode depender da porta.
    if (d.status === "closed" || d.contacts?.is_blocked) {
      const erro = d.contacts?.is_blocked ? "Contato bloqueado." : "Conversa fechada.";
      for (const o of origens) resultado.falhas.push({ message_id: o.id, erro });
      return resultado;
    }

    for (const o of origens) {
      try {
        const envio: SendMessageInput = {
          conversation_id: destinoId,
          type: o.type as SendMessageInput["type"],
          metadata: metadataDoEncaminhamento(o),
        };
        if (o.type === "text") {
          envio.body = o.body!.trim();
        } else {
          const origemPath = o.media_storage_path!;
          // Defesa em profundidade: o caminho veio do banco, mas copiar um objeto de fora da conversa de
          // origem seria ler o arquivo de outra pessoa.
          if (!isMediaPathOwnedBy(origemPath, ctx.organization_id, o.conversation_id)) {
            throw new ApiError(422, "invalid_media_path", undefined, ctx.requestId, "Arquivo fora da conversa.");
          }
          const destinoPath = `${ctx.organization_id}/${destinoId}/fwd-${randomUUID()}.${extFromMime(o.media_mime ?? "")}`;
          const { error: copiaErr } = await admin.storage.from(BUCKET).copy(origemPath, destinoPath);
          if (copiaErr) throw new Error(`não consegui copiar o arquivo: ${copiaErr.message}`);
          envio.media_storage_path = destinoPath;
          if (o.media_mime) envio.media_mime = o.media_mime;
          if (o.media_size_bytes && o.media_size_bytes > 0) envio.media_size_bytes = o.media_size_bytes;
          // A legenda vai junto, quando há.
          if (o.body?.trim()) envio.body = o.body.trim();
        }
        await sendMessageHandler(supabase, ctx, envio);
        resultado.enviadas += 1;
      } catch (err) {
        resultado.falhas.push({ message_id: o.id, erro: textoDoErro(err) });
      }
    }
    return resultado;
  };

  // Destinos em paralelo (são pessoas diferentes); as mensagens de cada um, em fila (a ordem importa).
  const resultados = await Promise.all(input.destination_conversation_ids.map(paraUmDestino));
  const total_enviadas = resultados.reduce((s, r) => s + r.enviadas, 0);
  const total_falhas = resultados.reduce((s, r) => s + r.falhas.length, 0);

  await audit({
    action: "message.forwarded",
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    organizationId: ctx.organization_id,
    resourceType: "conversation",
    resourceId: conversaDeOrigemId,
    requestId: ctx.requestId,
    metadata: {
      message_ids: input.message_ids,
      destination_conversation_ids: input.destination_conversation_ids,
      total_enviadas,
      total_falhas,
    },
  });

  return { destinos: resultados, total_enviadas, total_falhas };
}
