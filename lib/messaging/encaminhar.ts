/**
 * ENCAMINHAR MENSAGENS — as regras, sem tela e sem rede.
 *
 * Encaminhar é mandar o que um cliente disse (ou o que a equipe respondeu) para OUTRA conversa. Num CRM
 * de clínica isso é um dado de saúde de uma pessoa chegando ao WhatsApp de outra — o que o WhatsApp
 * permite e o CRM precisa tornar deliberado: o que pode ir, quanto de uma vez, e o que fica gravado.
 *
 * O envio em si NÃO é reinventado: cada cópia sai pelo mesmo caminho que qualquer mensagem do atendente
 * (`sendMessageHandler`), e por isso herda tudo o que ele já cobra — contato bloqueado, posse da mídia,
 * janela do canal, o provider. Aqui só se decide O QUÊ e PARA QUANTOS.
 */
import type { Message } from "@/lib/types/messaging";

/** Quantas mensagens por vez. O WhatsApp deixa mais, mas encaminhar em rajada é o que o rotula de spam. */
export const MAX_MENSAGENS_POR_ENCAMINHAMENTO = 5;
/** Para quantas conversas por vez — o mesmo teto do WhatsApp. */
export const MAX_DESTINOS_POR_ENCAMINHAMENTO = 5;

export type MotivoDeNaoEncaminhar =
  | "apagada"
  | "falhou"
  | "tipo_nao_suportado"
  | "sem_arquivo"
  | "sem_conteudo";

/** O texto que a tela mostra para cada motivo (em português; passa por `t()` na tela). */
export const TEXTO_DO_MOTIVO: Record<MotivoDeNaoEncaminhar, string> = {
  apagada: "Mensagem apagada não pode ser encaminhada",
  falhou: "Mensagem que não chegou a ser enviada não pode ser encaminhada",
  tipo_nao_suportado: "Este tipo de mensagem ainda não pode ser encaminhado",
  sem_arquivo: "O arquivo desta mensagem não está disponível para encaminhar",
  sem_conteudo: "Mensagem sem conteúdo",
};

const TIPOS_DE_ARQUIVO = new Set(["image", "audio", "video", "document", "sticker"]);

type Encaminhavel = Pick<
  Message,
  "type" | "body" | "revoked_at" | "status" | "media_storage_path" | "media_url"
>;

export type PodeEncaminhar = { ok: true } | { ok: false; motivo: MotivoDeNaoEncaminhar };

/**
 * Esta mensagem pode ser encaminhada?
 *
 * Só texto e arquivo que está NO NOSSO armazenamento: sem isso não há o que copiar (a URL do provider
 * expira e é de outro canal). Contato, localização e modelo ficam de fora de propósito — cada um carrega
 * dado que a cópia perderia ou distorceria (o modelo, por exemplo, tem custo e regras de janela próprios).
 */
export function podeEncaminhar(m: Encaminhavel): PodeEncaminhar {
  if (m.revoked_at) return { ok: false, motivo: "apagada" };
  // O que nunca chegou ao cliente não é "o que foi dito" — encaminhá-lo seria mandar a outra pessoa algo
  // que a primeira nunca recebeu.
  if (m.status === "failed") return { ok: false, motivo: "falhou" };

  if (m.type === "text") {
    return m.body?.trim() ? { ok: true } : { ok: false, motivo: "sem_conteudo" };
  }
  if (TIPOS_DE_ARQUIVO.has(m.type)) {
    return m.media_storage_path ? { ok: true } : { ok: false, motivo: "sem_arquivo" };
  }
  return { ok: false, motivo: "tipo_nao_suportado" };
}

/** A marca que fica na mensagem enviada: de onde veio, e que é um encaminhamento. */
export function metadataDoEncaminhamento(origem: Pick<Message, "id" | "conversation_id">) {
  return {
    forwarded: true,
    forwarded_from_message_id: origem.id,
    forwarded_from_conversation_id: origem.conversation_id,
  } as const;
}

/** Esta mensagem foi enviada POR um encaminhamento? (a bolha mostra "Encaminhada") */
export function foiEncaminhada(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.forwarded === true;
}

export type ErroDeValidacao = { ok: false; codigo: string; mensagem: string };

/** Confere os dois tetos e a ausência de duplicata, ANTES de tocar em qualquer conversa. */
export function validarPedido(
  mensagens: readonly string[],
  destinos: readonly string[],
): { ok: true } | ErroDeValidacao {
  if (mensagens.length === 0) return { ok: false, codigo: "sem_mensagens", mensagem: "Escolha ao menos uma mensagem." };
  if (destinos.length === 0) return { ok: false, codigo: "sem_destino", mensagem: "Escolha ao menos uma conversa." };
  if (mensagens.length > MAX_MENSAGENS_POR_ENCAMINHAMENTO) {
    return {
      ok: false,
      codigo: "mensagens_demais",
      mensagem: `Dá para encaminhar até ${MAX_MENSAGENS_POR_ENCAMINHAMENTO} mensagens de uma vez.`,
    };
  }
  if (destinos.length > MAX_DESTINOS_POR_ENCAMINHAMENTO) {
    return {
      ok: false,
      codigo: "destinos_demais",
      mensagem: `Dá para encaminhar para até ${MAX_DESTINOS_POR_ENCAMINHAMENTO} conversas de uma vez.`,
    };
  }
  if (new Set(mensagens).size !== mensagens.length || new Set(destinos).size !== destinos.length) {
    return { ok: false, codigo: "duplicado", mensagem: "Há mensagem ou conversa repetida no pedido." };
  }
  return { ok: true };
}
