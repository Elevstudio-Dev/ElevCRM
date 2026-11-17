// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_book_appointment` COM a agenda da secretaria ligada: a IA não marca — segura o horário e a recepção confirma.
 *
 * O que se prova: o que a IA recebe é `marcado: false` + `aguardando_confirmacao: true` (nunca um "marcado" que o
 * levasse a prometer o que ainda não existe); a recusa da reserva volta como RESPOSTA; e sem a secretaria ligada o
 * handler de marcar é chamado como sempre, sem tocar na reserva.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));
vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, idDoTipoPorSlug: vi.fn() };
});
vi.mock("@/lib/agenda/secretaria/reservar", () => ({ pedirReserva: vi.fn() }));

const { idDoTipoPorSlug } = await import("@/lib/agenda/consulta");
const { pedirReserva } = await import("@/lib/agenda/secretaria/reservar");
const { crmBookAppointment } = await import("@/lib/mcp/tools/agendamento");
const { marcarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");

const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

const ENTRADA = {
  event_type_slug: "avaliacao-gratuita",
  starts_at: "2026-11-19T17:00:00Z",
  contact_id: "11111111-1111-4111-8111-111111111111",
  nome_completo: "Maria da Silva",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "tipo-1" } as never);
});

describe("crm_book_appointment × reserva com a secretaria", () => {
  it("segura o horário: devolve marcado:false + aguardando_confirmacao:true e NÃO chama o handler de marcar", async () => {
    vi.mocked(pedirReserva).mockResolvedValue({
      tipo: "aguardando",
      reservaId: "res-1",
      validadeMin: 15,
      fim: new Date("2026-11-19T17:30:00Z"),
    });
    const r = (await crmBookAppointment.handler(ENTRADA, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ marcado: false, aguardando_confirmacao: true, reserva_id: "res-1", validade_min: 15 });
    expect(String(r.mensagem)).toMatch(/NÃO diga que está marcado/);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("repassa ao pedido o nome completo, o contato e o instante exatos", async () => {
    vi.mocked(pedirReserva).mockResolvedValue({ tipo: "aguardando", reservaId: "r", validadeMin: 15, fim: new Date() });
    await crmBookAppointment.handler({ ...ENTRADA, notes: "prefere de tarde" }, ctx);
    expect(pedirReserva).toHaveBeenCalledWith(
      ctx.supabase,
      expect.objectContaining({
        organizationId: "org-1",
        eventTypeId: "tipo-1",
        contactId: ENTRADA.contact_id,
        nomeCompleto: "Maria da Silva",
        notas: "prefere de tarde",
        inicio: new Date("2026-11-19T17:00:00Z"),
      }),
    );
  });

  it("recusa da reserva volta como RESPOSTA (motivo + mensagem), nunca como exceção", async () => {
    vi.mocked(pedirReserva).mockResolvedValue({
      tipo: "recusa",
      motivo: "falta_nome_completo",
      mensagem: "pergunte o nome completo",
    });
    const r = await crmBookAppointment.handler({ ...ENTRADA, nome_completo: undefined }, ctx);
    expect(r).toEqual({ marcado: false, motivo: "falta_nome_completo", mensagem: "pergunte o nome completo" });
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("sem a secretaria ligada (null), marca como sempre — e o resultado é o de antes", async () => {
    vi.mocked(pedirReserva).mockResolvedValue(null);
    vi.mocked(marcarAgendamentoHandler).mockResolvedValue({ id: "appt-1", lembrete: { sera_enviado: false } });
    const r = (await crmBookAppointment.handler(ENTRADA, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ marcado: true });
    expect(marcarAgendamentoHandler).toHaveBeenCalledTimes(1);
  });

  it("a descrição ensina o sinal novo e o nome completo", () => {
    expect(crmBookAppointment.description).toMatch(/aguardando_confirmacao/);
    expect(crmBookAppointment.inputSchema).toHaveProperty("nome_completo");
  });
});
