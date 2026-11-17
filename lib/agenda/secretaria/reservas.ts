/**
 * A RESERVA DE HORÁRIO que espera a confirmação da secretaria (tabela `agenda_reservas_pendentes`, migration 0231).
 *
 * Com a agenda da secretaria ligada, a IA não marca a consulta sozinha: a agenda de verdade vive no CRM da franquia, e
 * só a secretaria sabe se o horário ainda está livre. O caminho é
 *
 *   paciente escolhe o horário → RESERVA (o horário fica SEGURADO) → a IA pergunta à secretaria →
 *     "sim"  → o servidor marca o compromisso e avisa o paciente
 *     "não"  → o paciente recebe horários parecidos
 *     (nada) → passou a validade: idem "não", e a equipe é avisada
 *
 * Este arquivo é a REGRA e o ACESSO AO BANCO da reserva, sem conversa e sem canal. Quem conversa está em
 * `lib/bastidor/secretaria/reservas-*.ts` e no worker.
 *
 * ## O que segura o horário
 *
 * - reserva `aguardando_secretaria` e ainda dentro da validade: o horário NÃO é oferecido a ninguém;
 * - reserva `recusada` depois da última conferência da agenda: a secretaria disse que está ocupado e a agenda daqui
 *   ainda não sabe disso — sem este critério a IA ofereceria de novo, na mesma conversa, o horário que acabou de ser
 *   recusado. Uma agenda conferida DEPOIS é mais nova que a recusa e passa a mandar.
 *
 * Quem fecha a reserva a "reivindica" com um UPDATE condicionado ao estado (`status = 'aguardando_secretaria'`): se
 * dois processos tentam fechar a mesma reserva (a resposta dela e o vencimento no mesmo minuto), só um ganha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO } from "../fuso";
import type { LinhaDeAgendamento } from "../ocupados";

import { ultimaConferidaDaOrg } from "./atualidade";

/** Quanto tempo o horário fica segurado esperando a secretaria. */
export const VALIDADE_DA_RESERVA_MIN = 15;

export const STATUS_DA_RESERVA = ["aguardando_secretaria", "confirmada", "recusada", "expirada", "cancelada"] as const;
export type StatusDaReserva = (typeof STATUS_DA_RESERVA)[number];

export interface Reserva {
  id: string;
  organizationId: string;
  /** O paciente. */
  contactId: string;
  eventTypeId: string;
  ownerUserId: string;
  inicio: Date;
  fim: Date;
  nomePaciente: string;
  notas: string | null;
  status: StatusDaReserva;
  expiraEm: Date;
  perguntadaEm: Date | null;
  respondidaEm: Date | null;
  appointmentId: string | null;
  pacienteAvisadoEm: Date | null;
}

interface LinhaDaReserva {
  id: string;
  organization_id: string;
  contact_id: string;
  event_type_id: string;
  owner_user_id: string;
  starts_at: string;
  ends_at: string;
  nome_paciente: string;
  notas: string | null;
  status: StatusDaReserva;
  expira_em: string;
  perguntada_em: string | null;
  respondida_em: string | null;
  appointment_id: string | null;
  paciente_avisado_em: string | null;
}

const COLUNAS =
  "id, organization_id, contact_id, event_type_id, owner_user_id, starts_at, ends_at, nome_paciente, notas, status, expira_em, perguntada_em, respondida_em, appointment_id, paciente_avisado_em";

const data = (v: string | null): Date | null => (v === null ? null : new Date(v));

function deLinha(l: LinhaDaReserva): Reserva {
  return {
    id: l.id,
    organizationId: l.organization_id,
    contactId: l.contact_id,
    eventTypeId: l.event_type_id,
    ownerUserId: l.owner_user_id,
    inicio: new Date(l.starts_at),
    fim: new Date(l.ends_at),
    nomePaciente: l.nome_paciente,
    notas: l.notas,
    status: l.status,
    expiraEm: new Date(l.expira_em),
    perguntadaEm: data(l.perguntada_em),
    respondidaEm: data(l.respondida_em),
    appointmentId: l.appointment_id,
    pacienteAvisadoEm: data(l.paciente_avisado_em),
  };
}

function erro(contexto: string, e: { message: string } | null): void {
  if (e) throw new Error(`${contexto}: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// O que a reserva faz com a agenda
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Os horários que as reservas SEGURAM para um dono, como linhas de compromisso (o formato que `ocupadosDoDono` lê).
 * `ignorarReservaId`: a reserva que está sendo CONFIRMADA não pode bloquear a própria marcação.
 */
export async function reservasQueOcupam(
  supabase: SupabaseClient,
  organizationId: string,
  donoUserId: string,
  janela: { de: Date; ate: Date },
  agora: Date,
  ignorarReservaId?: string | null,
): Promise<LinhaDeAgendamento[]> {
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select("id, starts_at, ends_at, status, expira_em, respondida_em")
    .eq("organization_id", organizationId)
    .eq("owner_user_id", donoUserId)
    .in("status", ["aguardando_secretaria", "recusada"])
    .lt("starts_at", janela.ate.toISOString())
    .gt("ends_at", janela.de.toISOString());
  erro("agenda_reservas_pendentes", error);

  const candidatas = (linhas ?? []) as Array<
    Pick<LinhaDaReserva, "id" | "starts_at" | "ends_at" | "status" | "expira_em" | "respondida_em">
  >;
  if (candidatas.length === 0) return [];

  // A recusa só segura o horário enquanto a agenda daqui não foi conferida de novo. Só lê a conferência se precisar.
  let ultimaConferida: Date | null | undefined;
  const ocupadas: LinhaDeAgendamento[] = [];
  for (const c of candidatas) {
    if (c.id === ignorarReservaId) continue;
    if (c.status === "aguardando_secretaria") {
      if (new Date(c.expira_em).getTime() > agora.getTime()) {
        ocupadas.push({ starts_at: c.starts_at, ends_at: c.ends_at, status: "confirmed" });
      }
      continue;
    }
    // recusada
    if (ultimaConferida === undefined) ultimaConferida = await ultimaConferidaDaOrg(supabase, organizationId);
    const recusadaEm = c.respondida_em === null ? null : new Date(c.respondida_em);
    const agendaMaisNovaQueARecusa =
      ultimaConferida !== null && recusadaEm !== null && ultimaConferida.getTime() > recusadaEm.getTime();
    if (!agendaMaisNovaQueARecusa) {
      ocupadas.push({ starts_at: c.starts_at, ends_at: c.ends_at, status: "confirmed" });
    }
  }
  return ocupadas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Criar, perguntar, fechar
// ─────────────────────────────────────────────────────────────────────────────

export interface NovaReserva {
  organizationId: string;
  contactId: string;
  eventTypeId: string;
  ownerUserId: string;
  inicio: Date;
  fim: Date;
  nomePaciente: string;
  notas?: string | null;
  agora: Date;
}

export type ResultadoDaCriacao =
  | { ok: true; reserva: Reserva }
  | { ok: false; motivo: "horario_segurado" };

/**
 * Segura o horário para o paciente. O banco é quem decide a corrida: o índice único parcial recusa a segunda reserva
 * do mesmo horário, e aqui a recusa vira `horario_segurado` (nunca exceção). Se o paciente já segurava OUTRO horário
 * esperando a secretaria, aquele é cancelado primeiro — ele mudou de ideia, e ninguém fica com dois horários.
 */
export async function criarReserva(supabase: SupabaseClient, nova: NovaReserva): Promise<ResultadoDaCriacao> {
  const { error: eCancela } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ status: "cancelada", respondida_em: nova.agora.toISOString() })
    .eq("organization_id", nova.organizationId)
    .eq("contact_id", nova.contactId)
    .eq("status", "aguardando_secretaria");
  erro("agenda_reservas_pendentes", eCancela);

  const { data: criada, error } = await supabase
    .from("agenda_reservas_pendentes")
    .insert({
      organization_id: nova.organizationId,
      contact_id: nova.contactId,
      event_type_id: nova.eventTypeId,
      owner_user_id: nova.ownerUserId,
      starts_at: nova.inicio.toISOString(),
      ends_at: nova.fim.toISOString(),
      nome_paciente: nova.nomePaciente,
      notas: nova.notas ?? null,
      expira_em: new Date(nova.agora.getTime() + VALIDADE_DA_RESERVA_MIN * 60_000).toISOString(),
    })
    .select(COLUNAS)
    .single();
  if (error) {
    // 23505 = violação de unicidade: o horário já está segurado por outra conversa.
    if ((error as { code?: string }).code === "23505") return { ok: false, motivo: "horario_segurado" };
    throw new Error(`agenda_reservas_pendentes: ${error.message}`);
  }
  return { ok: true, reserva: deLinha(criada as LinhaDaReserva) };
}

export async function lerReserva(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
): Promise<Reserva | null> {
  const { data: linha, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .maybeSingle();
  erro("agenda_reservas_pendentes", error);
  return linha ? deLinha(linha as LinhaDaReserva) : null;
}

/** A reserva que a secretaria está respondendo agora: a que ela JÁ foi perguntada e ainda espera. A mais antiga. */
export async function reservaEmPerguntaAberta(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Reserva | null> {
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("status", "aguardando_secretaria")
    .not("perguntada_em", "is", null)
    .order("perguntada_em", { ascending: true })
    .limit(1);
  erro("agenda_reservas_pendentes", error);
  const l = linhas?.[0] as LinhaDaReserva | undefined;
  return l ? deLinha(l) : null;
}

/**
 * A próxima reserva a perguntar: a mais antiga que ainda não foi perguntada, dentro da validade — e SÓ se a secretaria
 * não está com outra pergunta em aberto. Uma pergunta por vez: um "sim" solto tem de ter um único significado.
 */
export async function proximaReservaAPerguntar(
  supabase: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<Reserva | null> {
  const emAberto = await reservaEmPerguntaAberta(supabase, organizationId);
  if (emAberto !== null && emAberto.expiraEm.getTime() > agora.getTime()) return null;
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("status", "aguardando_secretaria")
    .is("perguntada_em", null)
    .gt("expira_em", agora.toISOString())
    .order("created_at", { ascending: true })
    .limit(1);
  erro("agenda_reservas_pendentes", error);
  const l = linhas?.[0] as LinhaDaReserva | undefined;
  return l ? deLinha(l) : null;
}

/** Carimba a pergunta. `true` = esta chamada foi quem perguntou (o replay do job recebe `false` e não repete). */
export async function marcarReservaPerguntada(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
  agora: Date,
): Promise<boolean> {
  const { data: mexidas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ perguntada_em: agora.toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .eq("status", "aguardando_secretaria")
    .is("perguntada_em", null)
    .select("id");
  erro("agenda_reservas_pendentes", error);
  return (mexidas ?? []).length > 0;
}

/**
 * Reivindica o fechamento: só quem encontra a reserva ainda `aguardando_secretaria` consegue mudá-la. `true` = ganhou.
 */
export async function fecharReserva(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
  status: Exclude<StatusDaReserva, "aguardando_secretaria">,
  agora: Date,
): Promise<boolean> {
  const { data: mexidas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ status, respondida_em: agora.toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .eq("status", "aguardando_secretaria")
    .select("id");
  erro("agenda_reservas_pendentes", error);
  return (mexidas ?? []).length > 0;
}

/**
 * Falha de INFRAESTRUTURA entre "reivindicar a confirmação" e "marcar o compromisso": nada foi marcado nem dito a
 * ninguém, então a reserva volta a aguardar e o replay do job refaz o caminho. (Só desfaz se ainda não há compromisso.)
 */
export async function reabrirReserva(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
): Promise<void> {
  const { error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ status: "aguardando_secretaria", respondida_em: null })
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .eq("status", "confirmada")
    .is("appointment_id", null);
  erro("agenda_reservas_pendentes", error);
}

/** A reserva que já fechou como confirmada mas o compromisso falhou: volta a `recusada` (o horário não existe mais). */
export async function reverterConfirmacao(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
): Promise<void> {
  const { error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ status: "recusada" })
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .eq("status", "confirmada");
  erro("agenda_reservas_pendentes", error);
}

export async function ligarReservaAoCompromisso(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
  appointmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ appointment_id: appointmentId })
    .eq("organization_id", organizationId)
    .eq("id", reservaId);
  erro("agenda_reservas_pendentes", error);
}

/** Carimba que o paciente foi avisado do desfecho. `true` = esta chamada avisou (o replay recebe `false`). */
export async function marcarPacienteAvisado(
  supabase: SupabaseClient,
  organizationId: string,
  reservaId: string,
  agora: Date,
): Promise<boolean> {
  const { data: mexidas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .update({ paciente_avisado_em: agora.toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", reservaId)
    .is("paciente_avisado_em", null)
    .select("id");
  erro("agenda_reservas_pendentes", error);
  return (mexidas ?? []).length > 0;
}

/** Reservas que passaram da validade sem resposta (para o vencimento do cron). */
export async function reservasVencidas(
  supabase: SupabaseClient,
  agora: Date,
  limite = 50,
): Promise<Reserva[]> {
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("status", "aguardando_secretaria")
    .lte("expira_em", agora.toISOString())
    .order("expira_em", { ascending: true })
    .limit(limite);
  erro("agenda_reservas_pendentes", error);
  return ((linhas ?? []) as LinhaDaReserva[]).map(deLinha);
}

/** Reservas aguardando que ainda não foram perguntadas há mais de `minutos` (job perdido): o cron as reenfileira. */
export async function reservasSemPergunta(
  supabase: SupabaseClient,
  agora: Date,
  minutos = 2,
  limite = 50,
): Promise<Reserva[]> {
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("status", "aguardando_secretaria")
    .is("perguntada_em", null)
    .gt("expira_em", agora.toISOString())
    .lte("created_at", new Date(agora.getTime() - minutos * 60_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limite);
  erro("agenda_reservas_pendentes", error);
  return ((linhas ?? []) as LinhaDaReserva[]).map(deLinha);
}

/**
 * Reservas que a secretaria confirmou mas que NÃO viraram compromisso há mais de `minutos`: o processo caiu entre
 * reivindicar o "sim" e marcar. O cron avisa a equipe para fechar à mão — o paciente não foi avisado de nada.
 */
export async function reservasConfirmadasSemCompromisso(
  supabase: SupabaseClient,
  agora: Date,
  minutos = 3,
  limite = 50,
): Promise<Reserva[]> {
  const { data: linhas, error } = await supabase
    .from("agenda_reservas_pendentes")
    .select(COLUNAS)
    .eq("status", "confirmada")
    .is("appointment_id", null)
    .lte("respondida_em", new Date(agora.getTime() - minutos * 60_000).toISOString())
    .gt("starts_at", agora.toISOString())
    .order("respondida_em", { ascending: true })
    .limit(limite);
  erro("agenda_reservas_pendentes", error);
  return ((linhas ?? []) as LinhaDaReserva[]).map(deLinha);
}

// ─────────────────────────────────────────────────────────────────────────────
// Horários parecidos (quando a secretaria diz não, ou não responde)
// ─────────────────────────────────────────────────────────────────────────────

export interface HorarioLivre {
  inicio: Date;
  fim: Date;
}

const MIN_EM_MS = 60_000;

function minutoDoDia(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante);
  const h = Number(partes.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(partes.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Até `quantidade` horários livres PARECIDOS com o pedido, escolhidos no servidor (a IA não inventa alternativa):
 *
 *  1. o mais próximo NO MESMO DIA (se houver) — "tenho às 15h";
 *  2. o mais próximo em outro dia, na MESMA hora do dia ou perto dela — "ou amanhã às 14h".
 *
 * Se faltar um dos dois, completa com o que estiver mais perto no tempo. Nunca devolve o horário pedido nem horário
 * que já passou. O resultado sai em ordem cronológica, para a frase ficar natural.
 */
export function escolherHorariosParecidos(
  livres: readonly HorarioLivre[],
  pedido: Date,
  fuso: string,
  agora: Date,
  quantidade = 2,
): HorarioLivre[] {
  const candidatos = livres.filter(
    (s) => s.inicio.getTime() !== pedido.getTime() && s.inicio.getTime() > agora.getTime(),
  );
  if (candidatos.length === 0 || quantidade <= 0) return [];

  const diaPedido = diaLocalISO(pedido, fuso);
  const minutoPedido = minutoDoDia(pedido, fuso);

  const mesmoDia = candidatos
    .filter((s) => diaLocalISO(s.inicio, fuso) === diaPedido)
    .sort(
      (a, b) =>
        Math.abs(a.inicio.getTime() - pedido.getTime()) - Math.abs(b.inicio.getTime() - pedido.getTime()),
    );
  const outroDia = candidatos
    .filter((s) => diaLocalISO(s.inicio, fuso) !== diaPedido)
    .sort((a, b) => {
      const da = Math.abs(diasEntre(diaPedido, diaLocalISO(a.inicio, fuso)));
      const db = Math.abs(diasEntre(diaPedido, diaLocalISO(b.inicio, fuso)));
      if (da !== db) return da - db;
      return Math.abs(minutoDoDia(a.inicio, fuso) - minutoPedido) - Math.abs(minutoDoDia(b.inicio, fuso) - minutoPedido);
    });

  const escolhidos: HorarioLivre[] = [];
  if (mesmoDia[0]) escolhidos.push(mesmoDia[0]);
  if (outroDia[0] && escolhidos.length < quantidade) escolhidos.push(outroDia[0]);

  // Completa com o mais próximo no tempo, se algum dos dois faltou.
  if (escolhidos.length < quantidade) {
    const jaTem = new Set(escolhidos.map((s) => s.inicio.getTime()));
    const restantes = candidatos
      .filter((s) => !jaTem.has(s.inicio.getTime()))
      .sort(
        (a, b) =>
          Math.abs(a.inicio.getTime() - pedido.getTime()) - Math.abs(b.inicio.getTime() - pedido.getTime()),
      );
    for (const r of restantes) {
      if (escolhidos.length >= quantidade) break;
      escolhidos.push(r);
    }
  }
  return escolhidos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

/** A reserva ainda pode ser respondida? (aguardando e dentro da validade) */
export function reservaValeAinda(reserva: Pick<Reserva, "status" | "expiraEm">, agora: Date): boolean {
  return reserva.status === "aguardando_secretaria" && reserva.expiraEm.getTime() > agora.getTime();
}

/** Minutos que faltam para a reserva vencer (nunca negativo) — para a mensagem à secretaria. */
export function minutosParaVencer(reserva: Pick<Reserva, "expiraEm">, agora: Date): number {
  return Math.max(0, Math.ceil((reserva.expiraEm.getTime() - agora.getTime()) / MIN_EM_MS));
}
