/**
 * PASSO 1b DA ENTRADA: A MENSAGEM VEIO DE UM QR?
 *
 * A mensagem pronta do QR termina em `#CÓDIGO`. Aqui ela é casada com o QR da MESMA organização, a conversa é
 * registrada (uma vez por QR) e o QR volta para quem vai abrir a demanda — o lead NOVO nasce com origem QR.
 * Lead já aberto não muda de origem (primeiro toque, decisão do dono): só a conversa entra na conta do QR.
 *
 * Mensagem sem código não toca o banco — é o caso de quase toda mensagem, e ele tem de custar zero.
 * Nada aqui derruba a ingestão: falha vira log e o lead nasce sem origem de QR.
 */
import type { OrigemDoNascimento } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";
import { extrairCodigoDaMensagem } from "@/lib/qr-codes/codigo";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export const ROTULO_DA_TAG_DE_QR = "QR code";

export interface QrReconhecido {
  id: string;
  nome: string;
  codigo: string;
}

export interface MensagemParaReconhecer {
  organizationId: string;
  conversationId: string;
  contactId: string;
  messageId: string | null;
  texto: string | null;
}

export async function reconhecerQrCodeNaEntrada(
  admin: Admin,
  m: MensagemParaReconhecer,
): Promise<QrReconhecido | null> {
  const codigo = extrairCodigoDaMensagem(m.texto);
  if (!codigo) return null;

  try {
    // Atribuição é sobre a PESSOA que leu o QR; num grupo, quem escreveu é um participante.
    const { data: conversa } = await admin
      .from("conversations")
      .select("is_group")
      .eq("organization_id", m.organizationId)
      .eq("id", m.conversationId)
      .maybeSingle();
    if ((conversa as { is_group: boolean } | null)?.is_group) return null;

    // Arquivado CONTA: arquivar tira o QR de circulação, não apaga o fato de que alguém chegou por ele.
    const { data: qrBruto } = await admin
      .from("qr_codes")
      .select("id, nome, codigo")
      .eq("organization_id", m.organizationId)
      .eq("codigo", codigo)
      .maybeSingle();
    const qr = qrBruto as QrReconhecido | null;
    if (!qr) return null;

    const { error } = await admin.from("qr_code_conversas").insert({
      organization_id: m.organizationId,
      qr_code_id: qr.id,
      conversation_id: m.conversationId,
      contact_id: m.contactId,
      message_id: m.messageId,
    });
    // 23505 = esta conversa já foi contada para este QR. Não é erro, e o QR continua valendo para o lead.
    if (error && error.code !== "23505") {
      logger.warn("qr: conversa não registrada (o lead segue)", {
        organization_id: m.organizationId,
        qr_code_id: qr.id,
        detail: error.message.slice(0, 160),
      });
    }
    return qr;
  } catch (err) {
    logger.warn("qr: reconhecimento falhou (a mensagem entra sem origem de QR)", {
      organization_id: m.organizationId,
      conversation_id: m.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}

export function origemDoQr(qr: QrReconhecido): OrigemDoNascimento {
  return {
    source: "qr_code",
    sourceMetadata: { qr_code_id: qr.id, qr_code_nome: qr.nome, qr_code_codigo: qr.codigo },
    tags: [ROTULO_DA_TAG_DE_QR],
  };
}

/** O lead que nasceu desta conversa fica ligado à linha do QR (o funil do QR conta leads pelo lead). */
export async function vincularLeadAoQr(
  admin: Admin,
  v: { organizationId: string; conversationId: string; qrCodeId: string; leadId: string },
): Promise<void> {
  const { error } = await admin
    .from("qr_code_conversas")
    .update({ lead_id: v.leadId })
    .eq("organization_id", v.organizationId)
    .eq("qr_code_id", v.qrCodeId)
    .eq("conversation_id", v.conversationId);
  if (error) {
    logger.warn("qr: lead não vinculado à conversa do QR", {
      organization_id: v.organizationId,
      qr_code_id: v.qrCodeId,
      detail: error.message.slice(0, 160),
    });
  }
}
