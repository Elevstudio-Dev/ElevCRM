/**
 * PEDIR A RESERVA — o que `crm_book_appointment` faz quando a agenda da secretaria está ligada.
 *
 * Sem a secretaria ligada, a ferramenta marca direto (o caminho de sempre). Com ela ligada, a IA NÃO marca: a agenda
 * de verdade vive no CRM da franquia e quem sabe é a secretaria. Então este arquivo
 *
 *   1. confere que o horário veio de uma consulta FRESCA (agenda conferida há pouco) e ainda está livre;
 *   2. confere que há com quem confirmar (uma secretaria com conversa aberta) — sem isso não segura horário nenhum;
 *   3. SEGURA o horário (a corrida entre conversas é decidida pelo banco, ver a migration 0231);
 *   4. enfileira a pergunta à secretaria.
 *
 * Devolve `null` quando a secretaria não está ligada (o chamador marca como sempre), ou um desfecho para a IA:
 * `aguardando` (diga que a recepção está confirmando) ou `recusa` (o que fazer em seguida — nunca exceção).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { horariosLivresDaOrg } from "../consulta";

import { situacaoDaAgendaDaSecretaria } from "./atualidade";
import { conversaDaSecretariaDaOrg, enfileirarTrabalhoDaReserva } from "./conversa";
import { criarReserva, VALIDADE_DA_RESERVA_MIN } from "./reservas";

export interface PedidoDeReserva {
  organizationId: string;
  eventTypeId: string;
  contactId: string;
  inicio: Date;
  ownerUserId?: string | null;
  /** O nome COMPLETO que o paciente disse. A secretaria precisa dele para achar o paciente na agenda dela. */
  nomeCompleto?: string | null;
  notas?: string | null;
  agora: Date;
}

export type DesfechoDoPedido =
  | { tipo: "aguardando"; reservaId: string; validadeMin: number; fim: Date }
  | { tipo: "recusa"; motivo: string; mensagem: string };

const EQUIPE_CONFIRMA = "Avise que alguém da equipe confirma o horário.";

const recusa = (motivo: string, mensagem: string): DesfechoDoPedido => ({ tipo: "recusa", motivo, mensagem });

/** Nome completo = pelo menos duas palavras de verdade. "Maria" sozinha não basta para achar alguém numa agenda. */
export function nomeCompletoValido(nome: string | null | undefined): nome is string {
  if (typeof nome !== "string") return false;
  const palavras = nome.trim().split(/\s+/).filter((p) => p.length >= 2);
  return palavras.length >= 2 && nome.trim().length <= 200;
}

export async function pedirReserva(admin: SupabaseClient, pedido: PedidoDeReserva): Promise<DesfechoDoPedido | null> {
  const { organizationId, agora } = pedido;

  const situacao = await situacaoDaAgendaDaSecretaria(admin, organizationId, agora);
  if (situacao.estado === "sem_secretaria") return null;

  if (!nomeCompletoValido(pedido.nomeCompleto)) {
    return recusa(
      "falta_nome_completo",
      "Antes de reservar, pergunte ao paciente o NOME COMPLETO dele (nome e sobrenome) e chame esta ferramenta de novo " +
        "informando em `nome_completo`. A recepção precisa do nome inteiro para confirmar o horário.",
    );
  }
  const nome = pedido.nomeCompleto.trim().replace(/\s+/g, " ");

  const { data: tipo, error: eTipo } = await admin
    .from("calendar_event_types")
    .select("id, name, is_active, duration_minutes, default_owner_user_id")
    .eq("organization_id", organizationId)
    .eq("id", pedido.eventTypeId)
    .maybeSingle();
  if (eTipo) throw new Error(`calendar_event_types: ${eTipo.message}`);
  if (!tipo) return recusa("tipo_desconhecido", "Não encontrei esse tipo de atendimento. Pergunte à pessoa o que ela quer.");
  if (!tipo.is_active) return recusa("agenda_tipo_desativado", `Esse atendimento não está sendo agendado agora. ${EQUIPE_CONFIRMA}`);

  const donoId = pedido.ownerUserId ?? (tipo.default_owner_user_id as string | null);
  if (!donoId) return recusa("agenda_sem_responsavel", `Esse atendimento ainda não tem responsável definido. ${EQUIPE_CONFIRMA}`);

  // O contato é INPUT do modelo: precisa ser da organização (o mesmo cuidado de `marcarAgendamentoHandler`).
  const { data: contato, error: eContato } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", pedido.contactId)
    .maybeSingle();
  if (eContato) throw new Error(`contacts: ${eContato.message}`);
  if (!contato) return recusa("not_found", "Não encontrei esse contato. Confirme com quem você está falando.");

  const fim = new Date(pedido.inicio.getTime() + (tipo.duration_minutes as number) * 60_000);

  // O horário tem de ser um dos que a consulta FRESCA oferece: agenda conferida há pouco e ainda livre.
  const consulta = await horariosLivresDaOrg(admin, organizationId, {
    eventTypeId: pedido.eventTypeId,
    ownerUserId: donoId,
    de: pedido.inicio,
    ate: fim,
    agora,
    exigirAgendaConferida: true,
  });
  if (!consulta.ok) return recusa(consulta.codigo, consulta.motivoParaCliente);
  if (!consulta.publicouHorarios || !consulta.slots.some((s) => s.inicio.getTime() === pedido.inicio.getTime())) {
    return recusa(
      "agenda_horario_indisponivel",
      "Esse horário acabou de ficar indisponível. Chame `crm_find_free_slots` de novo e ofereça um dos horários que voltarem.",
    );
  }

  const secretaria = await conversaDaSecretariaDaOrg(admin, organizationId);
  if (secretaria === null) {
    return recusa(
      "sem_secretaria_para_confirmar",
      `Não consigo confirmar o horário com a recepção agora. ${EQUIPE_CONFIRMA}`,
    );
  }

  const criada = await criarReserva(admin, {
    organizationId,
    contactId: pedido.contactId,
    eventTypeId: pedido.eventTypeId,
    ownerUserId: donoId,
    inicio: pedido.inicio,
    fim,
    nomePaciente: nome,
    notas: pedido.notas ?? null,
    agora,
  });
  if (!criada.ok) {
    return recusa(
      "agenda_horario_indisponivel",
      "Esse horário acabou de ser reservado para outra pessoa. Chame `crm_find_free_slots` de novo e ofereça outro.",
    );
  }

  await enfileirarTrabalhoDaReserva(admin, organizationId, secretaria, "perguntar_reserva", criada.reserva.id);
  return { tipo: "aguardando", reservaId: criada.reserva.id, validadeMin: VALIDADE_DA_RESERVA_MIN, fim };
}
