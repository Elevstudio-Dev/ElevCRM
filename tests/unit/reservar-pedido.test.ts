// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PEDIR A RESERVA (o que `crm_book_appointment` faz com a agenda da secretaria ligada).
 *
 * O que se prova: organização sem a secretaria segue o caminho de sempre (devolve `null`); com ela ligada a IA NÃO
 * marca — segura o horário e enfileira a pergunta —, e cada recusa ENSINA o que fazer em vez de derrubar o turno.
 */
vi.mock("@/lib/agenda/secretaria/atualidade", () => ({ situacaoDaAgendaDaSecretaria: vi.fn() }));
vi.mock("@/lib/agenda/consulta", () => ({ horariosLivresDaOrg: vi.fn() }));
vi.mock("@/lib/agenda/secretaria/conversa", () => ({
  conversaDaSecretariaDaOrg: vi.fn(),
  enfileirarTrabalhoDaReserva: vi.fn(),
}));
vi.mock("@/lib/agenda/secretaria/reservas", () => ({
  criarReserva: vi.fn(),
  VALIDADE_DA_RESERVA_MIN: 15,
}));

const { situacaoDaAgendaDaSecretaria } = await import("@/lib/agenda/secretaria/atualidade");
const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { conversaDaSecretariaDaOrg, enfileirarTrabalhoDaReserva } = await import("@/lib/agenda/secretaria/conversa");
const { criarReserva } = await import("@/lib/agenda/secretaria/reservas");
const { nomeCompletoValido, pedirReserva } = await import("@/lib/agenda/secretaria/reservar");

const AGORA = new Date("2026-11-18T15:00:00Z");
const INICIO = new Date("2026-11-19T17:00:00Z");
const TIPO = { id: "tipo-1", name: "Avaliação gratuita", is_active: true, duration_minutes: 30, default_owner_user_id: "dono-1" };

function adminDe(extra: { tipo?: unknown; contato?: unknown } = {}) {
  const unico: Record<string, unknown> = {
    calendar_event_types: "tipo" in extra ? extra.tipo : TIPO,
    contacts: "contato" in extra ? extra.contato : { id: "pac-1" },
  };
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      return q;
    },
  } as unknown as SupabaseClient;
}

const pedido = (extra: Record<string, unknown> = {}) => ({
  organizationId: "org-1",
  eventTypeId: "tipo-1",
  contactId: "pac-1",
  inicio: INICIO,
  nomeCompleto: "Maria da Silva",
  agora: AGORA,
  ...extra,
});

const consultaOk = (slots = [{ inicio: INICIO, fim: new Date("2026-11-19T17:30:00Z") }]) =>
  ({
    ok: true,
    slots,
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(situacaoDaAgendaDaSecretaria).mockResolvedValue({ estado: "atual", config: {} as never });
  vi.mocked(horariosLivresDaOrg).mockResolvedValue(consultaOk());
  vi.mocked(conversaDaSecretariaDaOrg).mockResolvedValue({ contactId: "sec-1", conversationId: "conv-1", channelSessionId: "canal-1" });
  vi.mocked(criarReserva).mockResolvedValue({ ok: true, reserva: { id: "res-1" } as never });
});

describe("pedirReserva", () => {
  it("organização SEM a secretaria: devolve null (o chamador marca como sempre) e não mexe em nada", async () => {
    vi.mocked(situacaoDaAgendaDaSecretaria).mockResolvedValue({ estado: "sem_secretaria", config: {} as never });
    expect(await pedirReserva(adminDe(), pedido())).toBeNull();
    expect(criarReserva).not.toHaveBeenCalled();
    expect(enfileirarTrabalhoDaReserva).not.toHaveBeenCalled();
  });

  it("caminho feliz: SEGURA o horário e enfileira a pergunta à secretaria", async () => {
    const r = await pedirReserva(adminDe(), pedido());
    expect(r).toMatchObject({ tipo: "aguardando", reservaId: "res-1", validadeMin: 15 });
    expect(criarReserva).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: "dono-1", nomePaciente: "Maria da Silva", inicio: INICIO }),
    );
    expect(enfileirarTrabalhoDaReserva).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ contactId: "sec-1" }),
      "perguntar_reserva",
      "res-1",
    );
  });

  it("a consulta exige a agenda CONFERIDA (a mesma régua de quem oferece horário)", async () => {
    await pedirReserva(adminDe(), pedido());
    expect(vi.mocked(horariosLivresDaOrg).mock.calls[0]![2]).toMatchObject({ exigirAgendaConferida: true });
  });

  it("sem nome completo: recusa e ensina a perguntar — nada é segurado", async () => {
    for (const nomeCompleto of [undefined, null, "", "Maria"]) {
      const r = await pedirReserva(adminDe(), pedido({ nomeCompleto }));
      expect(r).toMatchObject({ tipo: "recusa", motivo: "falta_nome_completo" });
    }
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("agenda desatualizada: devolve a recusa da consulta (a frase do CLIENTE), sem segurar", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({
      ok: false,
      codigo: "agenda_desatualizada",
      motivoParaOperador: "operador",
      motivoParaCliente: "A agenda ainda não foi conferida.",
    });
    const r = await pedirReserva(adminDe(), pedido());
    expect(r).toEqual({ tipo: "recusa", motivo: "agenda_desatualizada", mensagem: "A agenda ainda não foi conferida." });
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("horário que não está entre os livres: manda consultar de novo", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(consultaOk([]));
    const r = await pedirReserva(adminDe(), pedido());
    expect(r).toMatchObject({ tipo: "recusa", motivo: "agenda_horario_indisponivel" });
    expect(String((r as { mensagem: string }).mensagem)).toMatch(/crm_find_free_slots/);
  });

  it("sem secretaria com conversa: não segura horário (ninguém para confirmar) e manda chamar a equipe", async () => {
    vi.mocked(conversaDaSecretariaDaOrg).mockResolvedValue(null);
    const r = await pedirReserva(adminDe(), pedido());
    expect(r).toMatchObject({ tipo: "recusa", motivo: "sem_secretaria_para_confirmar" });
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("outra conversa segurou o horário primeiro: recusa como indisponível", async () => {
    vi.mocked(criarReserva).mockResolvedValue({ ok: false, motivo: "horario_segurado" });
    const r = await pedirReserva(adminDe(), pedido());
    expect(r).toMatchObject({ tipo: "recusa", motivo: "agenda_horario_indisponivel" });
    expect(enfileirarTrabalhoDaReserva).not.toHaveBeenCalled();
  });

  it("contato de outra organização (uuid vindo do modelo) não vira reserva", async () => {
    const r = await pedirReserva(adminDe({ contato: null }), pedido());
    expect(r).toMatchObject({ tipo: "recusa", motivo: "not_found" });
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("tipo desativado ou sem responsável: recusa que ensina, sem segurar", async () => {
    expect(await pedirReserva(adminDe({ tipo: { ...TIPO, is_active: false } }), pedido())).toMatchObject({
      motivo: "agenda_tipo_desativado",
    });
    expect(await pedirReserva(adminDe({ tipo: { ...TIPO, default_owner_user_id: null } }), pedido())).toMatchObject({
      motivo: "agenda_sem_responsavel",
    });
    expect(criarReserva).not.toHaveBeenCalled();
  });
});

describe("nomeCompletoValido", () => {
  it("exige pelo menos duas palavras de verdade", () => {
    expect(nomeCompletoValido("Maria da Silva")).toBe(true);
    expect(nomeCompletoValido("  Ana   Paula ")).toBe(true);
    expect(nomeCompletoValido("Maria")).toBe(false);
    expect(nomeCompletoValido("M S")).toBe(false);
    expect(nomeCompletoValido("")).toBe(false);
    expect(nomeCompletoValido(null)).toBe(false);
    expect(nomeCompletoValido("a ".repeat(200))).toBe(false);
  });
});
