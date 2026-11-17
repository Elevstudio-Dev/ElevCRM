// @vitest-environment node
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CONVERSA DA RESERVA NO WORKER — as portas de verdade ligadas ao roteiro (`bastidor-reserva.ts`).
 *
 * O roteiro (sim/não/vencimento) tem teste próprio com portas de mentira; aqui se prova o ENCANAMENTO: quem é
 * chamado com o quê, em que ordem, e o que acontece quando o mundo falha:
 *
 *  - a pergunta à secretaria sai UMA vez por reserva e uma por vez por organização;
 *  - o "sim" marca o compromisso ignorando a PRÓPRIA reserva (ela seguraria o horário) e com o autor do motor;
 *  - falha de infraestrutura ao marcar REABRE a reserva e deixa o job tentar de novo (nada foi dito a ninguém);
 *  - recusa de negócio do handler ("horário tomado") vira conflito, não exceção;
 *  - paciente que não pôde ser avisado (veto, sem conversa) vira aviso à equipe, nunca silêncio;
 *  - depois de fechar uma reserva, a próxima da fila é perguntada.
 */
const ORG = "0be7a70a-0000-4000-8000-000000000001";
const SEC = "0be7a70a-0000-4000-8000-000000000002";
const CONV_SEC = "0be7a70a-0000-4000-8000-000000000003";
const SESSAO = "0be7a70a-0000-4000-8000-000000000004";
const PAC = "0be7a70a-0000-4000-8000-000000000005";
const AGORA = new Date("2026-11-18T15:00:00Z");

const marcarAgendamentoHandler = vi.fn();
const enviarAoBastidor = vi.fn();
const enviarAoPaciente = vi.fn();
const conversaDoContato = vi.fn();
const enfileirarTrabalhoDaReserva = vi.fn();
const lerReserva = vi.fn();
const fecharReserva = vi.fn();
const reabrirReserva = vi.fn();
const reverterConfirmacao = vi.fn();
const ligarReservaAoCompromisso = vi.fn();
const marcarPacienteAvisado = vi.fn();
const marcarReservaPerguntada = vi.fn();
const proximaReservaAPerguntar = vi.fn();
const horariosLivresDaOrg = vi.fn();

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: (...a: unknown[]) => marcarAgendamentoHandler(...a),
}));
vi.mock("@/lib/agent-engine/agent/bastidor-envio", () => ({
  enviarAoBastidor: (a: unknown) => enviarAoBastidor(a),
  enviarAoPaciente: (a: unknown) => enviarAoPaciente(a),
  fusoDaAgenda: async () => "America/Sao_Paulo",
}));
vi.mock("@/lib/agenda/secretaria/conversa", () => ({
  conversaDoContato: (...a: unknown[]) => conversaDoContato(...a),
  enfileirarTrabalhoDaReserva: (...a: unknown[]) => enfileirarTrabalhoDaReserva(...a),
}));
vi.mock("@/lib/agenda/consulta", () => ({ horariosLivresDaOrg: (...a: unknown[]) => horariosLivresDaOrg(...a) }));
vi.mock("@/lib/agenda/secretaria/reservas", async (original) => {
  const real = await original<typeof import("@/lib/agenda/secretaria/reservas")>();
  return {
    ...real,
    lerReserva: (...a: unknown[]) => lerReserva(...a),
    fecharReserva: (...a: unknown[]) => fecharReserva(...a),
    reabrirReserva: (...a: unknown[]) => reabrirReserva(...a),
    reverterConfirmacao: (...a: unknown[]) => reverterConfirmacao(...a),
    ligarReservaAoCompromisso: (...a: unknown[]) => ligarReservaAoCompromisso(...a),
    marcarPacienteAvisado: (...a: unknown[]) => marcarPacienteAvisado(...a),
    marcarReservaPerguntada: (...a: unknown[]) => marcarReservaPerguntada(...a),
    proximaReservaAPerguntar: (...a: unknown[]) => proximaReservaAPerguntar(...a),
  };
});

const { ApiError } = await import("@/lib/api/types");
const { executarTrabalhoDaReserva, tratarRespostaDaReserva } = await import("@/lib/agent-engine/agent/bastidor-reserva");

const reserva = (extra: Record<string, unknown> = {}) => ({
  id: "res-1",
  organizationId: ORG,
  contactId: PAC,
  eventTypeId: "tipo-1",
  ownerUserId: "dono-1",
  inicio: new Date("2026-11-19T17:00:00Z"),
  fim: new Date("2026-11-19T17:30:00Z"),
  nomePaciente: "Maria da Silva",
  notas: null,
  status: "aguardando_secretaria",
  expiraEm: new Date("2026-11-18T15:10:00Z"),
  perguntadaEm: new Date("2026-11-18T14:58:00Z"),
  respondidaEm: null,
  appointmentId: null,
  pacienteAvisadoEm: null,
  ...extra,
});

const queries: Array<{ sql: string; params: unknown[] }> = [];
const pool = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [] };
  }),
} as unknown as pg.Pool;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ADMIN = { admin: true };
const ctx = () =>
  ({
    pool,
    deps: { crmCfg: { supabase: ADMIN }, channel: () => ({}) },
    log,
    tenantId: ORG,
    secretariaId: SEC,
    conversationId: CONV_SEC,
    channelSessionId: SESSAO,
    jobId: "job-1",
    fusoDaOrg: "America/Sao_Paulo",
    agora: AGORA,
  }) as never;

const consulta = (slots: Array<{ inicio: Date; fim: Date }>) => ({
  ok: true,
  slots,
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  enviarAoBastidor.mockResolvedValue({ enviado: true });
  enviarAoPaciente.mockResolvedValue({ enviado: true });
  conversaDoContato.mockResolvedValue({ contactId: PAC, conversationId: "conv-pac", channelSessionId: "canal-pac" });
  fecharReserva.mockResolvedValue(true);
  marcarAgendamentoHandler.mockResolvedValue({ id: "appt-1" });
  marcarPacienteAvisado.mockResolvedValue(true);
  marcarReservaPerguntada.mockResolvedValue(true);
  proximaReservaAPerguntar.mockResolvedValue(null);
  horariosLivresDaOrg.mockResolvedValue(
    consulta([
      { inicio: new Date("2026-11-19T17:30:00Z"), fim: new Date("2026-11-19T18:00:00Z") },
      { inicio: new Date("2026-11-20T17:00:00Z"), fim: new Date("2026-11-20T17:30:00Z") },
    ]),
  );
});

describe("tratarRespostaDaReserva — 'sim'", () => {
  it("MARCA o compromisso ignorando a própria reserva, avisa o paciente pela cadeia e a secretaria como reserva_aviso", async () => {
    await tratarRespostaDaReserva(ctx(), reserva() as never, "sim");

    expect(fecharReserva).toHaveBeenCalledWith(ADMIN, ORG, "res-1", "confirmada", AGORA);
    expect(marcarAgendamentoHandler).toHaveBeenCalledTimes(1);
    const [, handlerCtx, input] = marcarAgendamentoHandler.mock.calls[0]!;
    expect(handlerCtx).toMatchObject({ organization_id: ORG, actor: { type: "ai_agent", id: "agent-engine" } });
    expect(input).toMatchObject({
      event_type_id: "tipo-1",
      starts_at: "2026-11-19T17:00:00.000Z",
      contact_id: PAC,
      owner_user_id: "dono-1",
      ignorar_reserva_id: "res-1",
    });
    expect(String(input.notes)).toContain("Maria da Silva");
    expect(ligarReservaAoCompromisso).toHaveBeenCalledWith(ADMIN, ORG, "res-1", "appt-1");

    expect(enviarAoPaciente).toHaveBeenCalledTimes(1);
    expect(enviarAoPaciente.mock.calls[0]![0]).toMatchObject({ pacienteId: PAC, conversationId: "conv-pac" });
    expect(String(enviarAoPaciente.mock.calls[0]![0].corpo)).toMatch(/confirmado/);
    expect(enviarAoBastidor.mock.calls[0]![0]).toMatchObject({ leadId: SEC, tipo: "reserva_aviso" });
    expect(marcarPacienteAvisado).toHaveBeenCalledTimes(1);
  });

  it("falha de INFRA ao marcar: REABRE a reserva, não diz nada a ninguém e deixa o job tentar de novo", async () => {
    marcarAgendamentoHandler.mockRejectedValue(new Error("banco fora"));
    await expect(tratarRespostaDaReserva(ctx(), reserva() as never, "sim")).rejects.toThrow("banco fora");
    expect(reabrirReserva).toHaveBeenCalledWith(ADMIN, ORG, "res-1");
    expect(enviarAoPaciente).not.toHaveBeenCalled();
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });

  it("recusa de NEGÓCIO do handler (horário tomado): desfaz, oferece outros e conta à secretaria — sem exceção", async () => {
    marcarAgendamentoHandler.mockRejectedValue(new ApiError(422, "agenda_horario_indisponivel", undefined, "req-1", "Este horário não está disponível."));
    await tratarRespostaDaReserva(ctx(), reserva() as never, "sim");
    expect(reabrirReserva).not.toHaveBeenCalled();
    expect(reverterConfirmacao).toHaveBeenCalledWith(ADMIN, ORG, "res-1");
    expect(String(enviarAoPaciente.mock.calls[0]![0].corpo)).toMatch(/acabou de ser preenchido/);
    expect(String(enviarAoBastidor.mock.calls[0]![0].corpo)).toMatch(/Não consegui anotar/);
  });

  it("os horários parecidos vêm da consulta com a agenda CONFERIDA exigida (a mesma régua da IA)", async () => {
    await tratarRespostaDaReserva(ctx(), reserva() as never, "nao");
    expect(horariosLivresDaOrg.mock.calls[0]![2]).toMatchObject({
      eventTypeId: "tipo-1",
      ownerUserId: "dono-1",
      exigirAgendaConferida: true,
    });
    expect(String(enviarAoPaciente.mock.calls[0]![0].corpo)).toMatch(/Tenho disponível .* ou /);
  });

  it("a consulta recusar (agenda desatualizada) não derruba: sem horário, a equipe é chamada", async () => {
    horariosLivresDaOrg.mockResolvedValue({ ok: false, codigo: "agenda_desatualizada" });
    await tratarRespostaDaReserva(ctx(), reserva() as never, "nao");
    expect(String(enviarAoPaciente.mock.calls[0]![0].corpo)).toMatch(/recepção te chamar/);
    expect(queries.some((q) => q.sql.includes("insert into agent_inbox_items"))).toBe(true);
  });
});

describe("tratarRespostaDaReserva — o paciente que não pôde ser avisado", () => {
  it("cadeia vetou: vira aviso à equipe com o que a IA queria dizer (nunca silêncio)", async () => {
    enviarAoPaciente.mockResolvedValue({ enviado: false, porque: "outside_window" });
    await tratarRespostaDaReserva(ctx(), reserva() as never, "sim");
    const aviso = queries.find((q) => q.sql.includes("insert into agent_inbox_items"));
    expect(aviso).toBeDefined();
    expect(String(aviso!.params[1])).toMatch(/Avise Maria da Silva/);
    expect(String(aviso!.params[2])).toMatch(/outside_window/);
    expect(marcarPacienteAvisado).not.toHaveBeenCalled();
  });

  it("paciente sem conversa aberta: também vira aviso à equipe", async () => {
    conversaDoContato.mockResolvedValue(null);
    await tratarRespostaDaReserva(ctx(), reserva() as never, "sim");
    expect(enviarAoPaciente).not.toHaveBeenCalled();
    expect(queries.some((q) => q.sql.includes("insert into agent_inbox_items"))).toBe(true);
  });

  it("o aviso à equipe é aberto uma vez só (o SQL ignora um aviso igual já aberto)", async () => {
    conversaDoContato.mockResolvedValue(null);
    await tratarRespostaDaReserva(ctx(), reserva() as never, "sim");
    const aviso = queries.find((q) => q.sql.includes("insert into agent_inbox_items"))!;
    expect(aviso.sql).toMatch(/where not exists/);
  });
});

describe("a fila: uma pergunta por vez", () => {
  it("fechada uma reserva, a PRÓXIMA da fila é perguntada", async () => {
    proximaReservaAPerguntar.mockResolvedValue({ id: "res-2" });
    await tratarRespostaDaReserva(ctx(), reserva() as never, "nao");
    expect(enfileirarTrabalhoDaReserva).toHaveBeenCalledWith(
      ADMIN,
      ORG,
      { contactId: SEC, conversationId: CONV_SEC, channelSessionId: SESSAO },
      "perguntar_reserva",
      "res-2",
    );
  });

  it("sem próxima, nada é enfileirado", async () => {
    await tratarRespostaDaReserva(ctx(), reserva() as never, "nao");
    expect(enfileirarTrabalhoDaReserva).not.toHaveBeenCalled();
  });
});

describe("executarTrabalhoDaReserva — perguntar_reserva", () => {
  const pedido = (acao: "perguntar_reserva" | "avisar_paciente_reserva" = "perguntar_reserva") => ({
    conversation_id: CONV_SEC,
    contact_id: SEC,
    channel_session_id: SESSAO,
    acao,
    reserva_id: "res-1",
  });

  it("pergunta à secretaria (texto fixo, tipo reserva_pergunta) depois de carimbar a pergunta", async () => {
    lerReserva.mockResolvedValue(reserva({ perguntadaEm: null }));
    proximaReservaAPerguntar.mockResolvedValue({ id: "res-1" });
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(marcarReservaPerguntada).toHaveBeenCalledWith(ADMIN, ORG, "res-1", AGORA);
    const envio = enviarAoBastidor.mock.calls[0]![0];
    expect(envio).toMatchObject({ leadId: SEC, tipo: "reserva_pergunta", conversationId: CONV_SEC });
    expect(String(envio.corpo)).toMatch(/Maria da Silva/);
    expect(String(envio.corpo)).toMatch(/SIM.*NÃO/s);
  });

  it("replay do job (já carimbada): NÃO pergunta de novo", async () => {
    lerReserva.mockResolvedValue(reserva({ perguntadaEm: null }));
    proximaReservaAPerguntar.mockResolvedValue({ id: "res-1" });
    marcarReservaPerguntada.mockResolvedValue(false);
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });

  it("outra pergunta em aberto: esta espera (adiada), sem carimbar nem enviar", async () => {
    lerReserva.mockResolvedValue(reserva({ perguntadaEm: null }));
    proximaReservaAPerguntar.mockResolvedValue(null);
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(marcarReservaPerguntada).not.toHaveBeenCalled();
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });

  it("reserva que já venceu ou fechou: dispensada", async () => {
    lerReserva.mockResolvedValue(reserva({ status: "recusada", perguntadaEm: null }));
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(enviarAoBastidor).not.toHaveBeenCalled();
    lerReserva.mockResolvedValue(reserva({ expiraEm: new Date("2026-11-18T14:00:00Z"), perguntadaEm: null }));
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });

  it("reserva inexistente: no-op", async () => {
    lerReserva.mockResolvedValue(null);
    await executarTrabalhoDaReserva(ctx(), pedido());
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });
});

describe("executarTrabalhoDaReserva — avisar_paciente_reserva (vencimento)", () => {
  const pedido = {
    conversation_id: CONV_SEC,
    contact_id: SEC,
    channel_session_id: SESSAO,
    acao: "avisar_paciente_reserva" as const,
    reserva_id: "res-1",
  };

  it("reserva EXPIRADA: o paciente recebe horários parecidos, a equipe é chamada e a secretaria é informada", async () => {
    lerReserva.mockResolvedValue(reserva({ status: "expirada" }));
    await executarTrabalhoDaReserva(ctx(), pedido);
    expect(String(enviarAoPaciente.mock.calls[0]![0].corpo)).toMatch(/acabou de ser preenchido/);
    expect(String(enviarAoBastidor.mock.calls[0]![0].corpo)).toMatch(/venceu sem resposta/);
    expect(queries.some((q) => q.sql.includes("insert into agent_inbox_items"))).toBe(true);
    // O cron é quem fecha: aqui não se reivindica o fechamento.
    expect(fecharReserva).not.toHaveBeenCalled();
  });

  it("reserva que NÃO está expirada (a secretaria respondeu a tempo): dispensado, ninguém é avisado", async () => {
    lerReserva.mockResolvedValue(reserva({ status: "confirmada" }));
    await executarTrabalhoDaReserva(ctx(), pedido);
    expect(enviarAoPaciente).not.toHaveBeenCalled();
    expect(enviarAoBastidor).not.toHaveBeenCalled();
  });
});
