/**
 * APLICAR UM RELATO CONFERIDO NA AGENDA — executa o plano de `sincronizar.ts` no banco.
 *
 * Roda com o cliente de SERVIÇO (a secretaria não é usuária do CRM): quem chama já provou que o relato é de uma
 * organização e foi conferido. Por isso este arquivo só lê e escreve filtrando SEMPRE por `organization_id`.
 *
 * ─── Três decisões que parecem detalhe e não são ───────────────────────────────────────────────────────────────
 *
 * 1. **Só toca no que um relato criou.** O compromisso nasce com `origem_relato_id`; o fechamento de dia, com o
 *    prefixo `[secretaria]` no motivo. Um compromisso marcado à mão ou pela IA de vendas nunca é cancelado por
 *    um relato, e um dia que um humano fechou nunca é reaberto por um relato.
 *
 * 2. **Já nasce "enviado ao Google".** `needs_google_push` é derivado de `google_synced_at`; sem carimbar, o job que
 *    espelha a agenda no Google Agenda publicaria "Maria" (nome de paciente) na agenda do dentista. O relato é um
 *    ESPELHO do que a secretaria viu na agenda da franquia, não um compromisso novo da clínica.
 *
 * 3. **Reexecutar é seguro.** Não há transação (o cliente é PostgREST): se algo falhar no meio, o relato continua
 *    `lido`, e rodar de novo recalcula o plano a partir do que já está gravado. Criar vem antes de cancelar, para
 *    uma falha no meio nunca deixar a agenda com MENOS do que a secretaria disse.
 *
 *    A EXCEÇÃO é a troca de paciente no MESMO horário (`plano.substituirIds`). O índice único
 *    `calendar_appointments_sem_duplicata_idx` (organização, dono, início, só vivos) não deixa o novo nascer enquanto o
 *    antigo vive — foi assim que a conferência caiu em produção (`duplicate key`, job morto, agenda parada). Então:
 *    cancela SÓ esses antigos, insere todos os novos num statement só e, se o insert falhar, RESTAURA os antigos no
 *    estado que tinham. A janela em que o horário fica vazio é a de um statement; se até a restauração falhar, o
 *    relato continua `lido` e reexecutar recria o horário (o antigo já está cancelado, então o plano manda criar).
 *
 * 4. **Não pisa no que não é dele.** Horário ocupado por compromisso que NÃO nasceu de relato (IA de vendas,
 *    marcação à mão) não é cancelado nem alterado: o espelho daquele horário simplesmente não é criado e volta como
 *    `conflitos`, para a resposta à secretaria dizer qual horário não foi anotado. A hora continua tomada (por
 *    outra coisa), então a agenda nunca fica com menos.
 *
 * O compromisso nasce sem contato e sem tipo: não é uma consulta de um paciente do CRM, é uma hora tomada. Sem
 * contato, o lembrete ao paciente nem arma (`portas-supabase.ts` só trata o que tem contato e tipo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { limitesDaJanela, problemasDoRelato, type RelatoLido } from "./relato";
import {
  conflitosComFechamento,
  motivoDoFechamento,
  planejarSincronizacao,
  PREFIXO_DO_MOTIVO,
  type CompromissoDoRelato,
  type ConflitoDeHorario,
  type FechamentoDoRelato,
} from "./sincronizar";

/** Um horário do relato que não foi anotado porque já havia outro compromisso nele (ver `ConflitoDeHorario`). */
export interface ConflitoAplicado {
  /** ISO. */
  inicio: string;
  nome: string;
  porque: ConflitoDeHorario["porque"];
}

export interface ResultadoDaAplicacao {
  criados: number;
  mantidos: number;
  cancelados: number;
  diasFechados: number;
  diasReabertos: number;
  conflitos: ConflitoAplicado[];
}

const VIVOS = ["pending", "confirmed"] as const;

export class RelatoIncoerente extends Error {
  constructor(public readonly problemas: string[]) {
    super(`relato incoerente: ${problemas.join("; ")}`);
    this.name = "RelatoIncoerente";
  }
}

const MOTIVO_DO_CANCELAMENTO = "Não consta mais no relato da secretaria.";

function falhou(onde: string, erro: { message: string }): never {
  throw new Error(`${onde}: ${erro.message}`);
}

export async function aplicarRelato(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    relatoId: string;
    /** O atendente dono da agenda (o dentista que faz a avaliação). */
    donoUserId: string;
    relato: RelatoLido;
    fuso: string;
    duracaoMin: number;
    /** INJETADO. */
    agora: Date;
  },
): Promise<ResultadoDaAplicacao> {
  const { organizationId, relatoId, donoUserId, relato, fuso, duracaoMin, agora } = args;

  // Defesa: um relato contraditório nunca chega ao banco (quem chama deveria ter perguntado de volta).
  const problemas = [
    ...problemasDoRelato(relato, fuso).map((p) => p.mensagem),
    ...conflitosComFechamento(relato, fuso).map((n) => `${n} está marcado(a) num dia que o mesmo relato fecha.`),
  ];
  if (problemas.length > 0) throw new RelatoIncoerente(problemas);

  const { inicio, fim } = limitesDaJanela(relato.janela, fuso);

  // 1. O que um relato anterior criou e ainda vale, dentro da janela.
  const { data: vivos, error: erroVivos } = await admin
    .from("calendar_appointments")
    .select("id, title, starts_at, ends_at, status")
    .eq("organization_id", organizationId)
    .eq("owner_user_id", donoUserId)
    .not("origem_relato_id", "is", null)
    .in("status", [...VIVOS])
    .gte("starts_at", inicio.toISOString())
    .lt("starts_at", fim.toISOString());
  if (erroVivos) falhou("ler compromissos do relato", erroVivos);

  const linhasVivas = (vivos ?? []) as Array<{ id: string; title: string; starts_at: string; ends_at: string; status: string }>;
  const existentes: CompromissoDoRelato[] = linhasVivas.map((l) => ({
    id: l.id,
    nome: l.title,
    inicio: new Date(l.starts_at),
    fim: new Date(l.ends_at),
  }));
  const statusAnterior = new Map(linhasVivas.map((l) => [l.id, l.status]));

  // 1b. O que ocupa a agenda do mesmo dono na janela e NÃO veio de relato: só o início importa (é o que o índice
  //     único compara). Nunca é tocado — serve para o plano não tentar criar um espelho em cima.
  const { data: outros, error: erroOutros } = await admin
    .from("calendar_appointments")
    .select("starts_at")
    .eq("organization_id", organizationId)
    .eq("owner_user_id", donoUserId)
    .is("origem_relato_id", null)
    .in("status", [...VIVOS])
    .gte("starts_at", inicio.toISOString())
    .lt("starts_at", fim.toISOString());
  if (erroOutros) falhou("ler compromissos fora do relato", erroOutros);
  const ocupadosForaDoRelato = ((outros ?? []) as Array<{ starts_at: string }>).map((l) => new Date(l.starts_at));

  // 2. Os dias que um relato fechou, dentro da janela.
  const { data: fechados, error: erroFechados } = await admin
    .from("calendar_availability_exceptions")
    .select("id, exception_date")
    .eq("organization_id", organizationId)
    .eq("user_id", donoUserId)
    .like("reason", `${PREFIXO_DO_MOTIVO}%`)
    .gte("exception_date", relato.janela.de)
    .lte("exception_date", relato.janela.ate);
  if (erroFechados) falhou("ler dias fechados do relato", erroFechados);

  const fechamentosExistentes: FechamentoDoRelato[] = (
    (fechados ?? []) as Array<{ id: string; exception_date: string }>
  ).map((l) => ({ id: l.id, data: String(l.exception_date).slice(0, 10) }));

  const plano = planejarSincronizacao({
    existentes,
    fechamentosExistentes,
    ocupadosForaDoRelato,
    relato,
    fuso,
    duracaoMin,
    agora,
  });

  const cancelamento = {
    status: "cancelled",
    cancelled_at: agora.toISOString(),
    cancellation_reason: MOTIVO_DO_CANCELAMENTO,
  };

  // 3a. A troca de paciente no MESMO horário: o antigo sai ANTES (ver a decisão 3 no cabeçalho). Só o que um relato
  //     criou e ainda está vivo — a guarda repete o filtro da leitura, para um id nunca alcançar outra coisa.
  if (plano.substituirIds.length > 0) {
    const { error } = await admin
      .from("calendar_appointments")
      .update(cancelamento)
      .eq("organization_id", organizationId)
      .not("origem_relato_id", "is", null)
      .in("status", [...VIVOS])
      .in("id", plano.substituirIds);
    if (error) falhou("liberar os horários trocados no relato", error);
  }

  // 3b. Criar (num statement só) antes de cancelar o resto.
  if (plano.criar.length > 0) {
    const linhas = plano.criar.map((c) => ({
      organization_id: organizationId,
      title: c.nome,
      starts_at: c.inicio.toISOString(),
      ends_at: c.fim.toISOString(),
      time_zone: fuso,
      status: "confirmed",
      owner_user_id: donoUserId,
      created_by_kind: "ai",
      source: "mcp",
      origem_relato_id: relatoId,
      // Ver a decisão 2 no cabeçalho: sem isto o nome do paciente iria para o Google Agenda.
      google_synced_at: agora.toISOString(),
    }));
    const { error } = await admin.from("calendar_appointments").insert(linhas);
    if (error) {
      const falhaDaRestauracao = await restaurar(admin, organizationId, plano.substituirIds, statusAnterior, agora);
      falhou(
        "criar compromissos do relato",
        falhaDaRestauracao
          ? { message: `${error.message} — e falhou ao restaurar os horários trocados: ${falhaDaRestauracao}` }
          : error,
      );
    }
  }

  const substituidos = new Set(plano.substituirIds);
  const cancelarDepois = plano.cancelarIds.filter((id) => !substituidos.has(id));
  if (cancelarDepois.length > 0) {
    const { error } = await admin
      .from("calendar_appointments")
      .update(cancelamento)
      .eq("organization_id", organizationId)
      .in("id", cancelarDepois);
    if (error) falhou("cancelar compromissos do relato", error);
  }

  // 4. Dias fechados. Um por vez: o dia que um humano já fechou colide (23505) e isso é o resultado certo — já está
  //    fechado, e não é um fechamento nosso para reabrir depois.
  let diasFechados = 0;
  for (const dia of plano.fecharDias) {
    const { error } = await admin.from("calendar_availability_exceptions").insert({
      organization_id: organizationId,
      user_id: donoUserId,
      exception_date: dia.data,
      is_unavailable: true,
      start_minute: 0,
      end_minute: 1440,
      reason: motivoDoFechamento(dia.motivo),
    });
    if (!error) diasFechados += 1;
    else if (error.code !== "23505") falhou(`fechar o dia ${dia.data}`, error);
  }

  let diasReabertos = 0;
  if (plano.reabrirIds.length > 0) {
    const { error } = await admin
      .from("calendar_availability_exceptions")
      .delete()
      .eq("organization_id", organizationId)
      .in("id", plano.reabrirIds);
    if (error) falhou("reabrir dias do relato", error);
    diasReabertos = plano.reabrirIds.length;
  }

  return {
    criados: plano.criar.length,
    mantidos: plano.manterIds.length,
    cancelados: plano.cancelarIds.length,
    diasFechados,
    diasReabertos,
    conflitos: plano.conflitos.map((c) => ({ inicio: c.inicio.toISOString(), nome: c.nome, porque: c.porque })),
  };
}

/**
 * Desfaz o cancelamento antecipado da troca de horário quando o insert falhou: cada compromisso volta ao estado que
 * tinha (`pending`/`confirmed`), sem carimbo de cancelamento, e de novo "já enviado ao Google" (decisão 2). Só
 * alcança o que ESTE passo cancelou: os ids do plano, ainda `cancelled`. Devolve a mensagem de erro, ou nulo.
 */
async function restaurar(
  admin: SupabaseClient,
  organizationId: string,
  ids: readonly string[],
  statusAnterior: ReadonlyMap<string, string>,
  agora: Date,
): Promise<string | null> {
  const porStatus = new Map<string, string[]>();
  for (const id of ids) {
    const status = statusAnterior.get(id) ?? "confirmed";
    porStatus.set(status, [...(porStatus.get(status) ?? []), id]);
  }
  for (const [status, lista] of porStatus) {
    const { error } = await admin
      .from("calendar_appointments")
      .update({ status, cancelled_at: null, cancellation_reason: null, google_synced_at: agora.toISOString() })
      .eq("organization_id", organizationId)
      .eq("status", "cancelled")
      .in("id", lista);
    if (error) return error.message;
  }
  return null;
}
