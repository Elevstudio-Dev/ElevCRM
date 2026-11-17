/**
 * ONDE A IA FALA COM A SECRETARIA (e com o paciente) — as conversas que a reserva de horário usa.
 *
 * A secretaria é um contato com `papel_interno = 'secretaria'` (migration 0227). Para a IA lhe escrever precisa existir
 * uma conversa individual com ela no canal da clínica (basta ela mandar um "oi" ao número). O paciente é o contato da
 * conversa em que ele escolheu o horário. Nos dois casos pega-se a conversa individual mais recente.
 *
 * Tudo com o cliente administrativo (service role): `organization_id` vai em TODA consulta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversaDeContato {
  contactId: string;
  conversationId: string;
  channelSessionId: string;
}

function erro(contexto: string, e: { message: string } | null): void {
  if (e) throw new Error(`${contexto}: ${e.message}`);
}

/** A conversa individual mais recente de um contato, ou nulo. */
export async function conversaDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<ConversaDeContato | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id, channel_session_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("is_group", false)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  erro("conversations", error);
  const c = data?.[0] as { id: string; channel_session_id: string } | undefined;
  return c ? { contactId, conversationId: c.id, channelSessionId: c.channel_session_id } : null;
}

/**
 * A secretaria da organização COM conversa aberta (a primeira que tiver, se houver mais de uma). Nulo = ninguém com o
 * papel, ou ela ainda nunca escreveu ao número — a IA não tem como lhe perguntar.
 */
export async function conversaDaSecretariaDaOrg(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ConversaDeContato | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("papel_interno", "secretaria")
    .eq("is_blocked", false)
    .eq("is_anonymized", false);
  erro("contacts", error);
  for (const c of (data ?? []) as Array<{ id: string }>) {
    const conversa = await conversaDoContato(admin, organizationId, c.id);
    if (conversa !== null) return conversa;
  }
  return null;
}

/** Os tipos de pedido que o worker entende no job `bastidor_turn` da reserva. */
export type AcaoDaReserva = "perguntar_reserva" | "avisar_paciente_reserva";

/**
 * Põe na fila o trabalho de falar sobre uma reserva. O envio NÃO sai daqui: o worker manda pela mesma cadeia de
 * proteções de qualquer mensagem (`runBeforeSend`). O contato do job é a secretaria (o CHECK da fila exige um).
 */
export async function enfileirarTrabalhoDaReserva(
  admin: SupabaseClient,
  organizationId: string,
  secretaria: ConversaDeContato,
  acao: AcaoDaReserva,
  reservaId: string,
): Promise<void> {
  const { error } = await admin.from("job_queue").insert({
    organization_id: organizationId,
    contact_id: secretaria.contactId,
    kind: "bastidor_turn",
    payload: {
      conversation_id: secretaria.conversationId,
      contact_id: secretaria.contactId,
      channel_session_id: secretaria.channelSessionId,
      acao,
      reserva_id: reservaId,
    },
  });
  erro("job_queue", error);
}
