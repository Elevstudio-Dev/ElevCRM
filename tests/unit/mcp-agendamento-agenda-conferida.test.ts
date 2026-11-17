// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_find_free_slots` e a agenda da secretaria: a IA SEMPRE pede a agenda conferida, e o que ela recebe quando a
 * agenda envelheceu é ensino (não oferecer horário), nunca uma lista vazia que pareceria "sem vaga".
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));
vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { crmFindFreeSlots } = await import("@/lib/mcp/tools/agendamento");

const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

const slot = { inicio: new Date("2026-11-19T17:00:00Z"), fim: new Date("2026-11-19T17:30:00Z") };
const sucesso = (extra: Partial<Extract<ResultadoDaConsulta, { ok: true }>> = {}): ResultadoDaConsulta => ({
  ok: true,
  slots: [slot],
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
  ...extra,
});

describe("crm_find_free_slots × agenda da secretaria", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a IA SEMPRE pede a agenda conferida (o parâmetro não depende do que o modelo mandar)", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(sucesso());
    await crmFindFreeSlots.handler({ event_type_slug: "avaliacao-gratuita", dias_a_frente: 7 }, ctx);
    expect(vi.mocked(horariosLivresDaOrg).mock.calls[0]![2].exigirAgendaConferida).toBe(true);
  });

  it("agenda desatualizada: devolve `motivo` e a frase do CLIENTE (não oferecer horário), sem lista", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({
      ok: false,
      codigo: "agenda_desatualizada",
      motivoParaOperador: "Peça à secretaria que confirme a agenda.",
      motivoParaCliente: "A agenda ainda não foi conferida com a recepção hoje. Não ofereça horários e não diga que está sem vaga.",
    });
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "avaliacao-gratuita" }, ctx)) as {
      horarios: unknown[];
      motivo: string;
      mensagem: string;
    };
    expect(r.horarios).toEqual([]);
    expect(r.motivo).toBe("agenda_desatualizada");
    expect(r.mensagem).toMatch(/não ofereça horários/i);
    expect(r.mensagem).not.toMatch(/Peça à secretaria/);
  });

  it("'sem_hoje' chega ao modelo, para ele não prometer horário de hoje", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(sucesso({ agendaDaSecretaria: "sem_hoje" }));
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "avaliacao-gratuita" }, ctx)) as {
      agenda_da_secretaria?: string;
    };
    expect(r.agenda_da_secretaria).toBe("sem_hoje");
  });

  it("organização que não usa a secretaria: o campo nem aparece (resposta idêntica à de antes)", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(sucesso({ agendaDaSecretaria: "sem_secretaria" }));
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "avaliacao-gratuita" }, ctx)) as Record<string, unknown>;
    expect("agenda_da_secretaria" in r).toBe(false);
  });

  it("a descrição da ferramenta ensina os dois sinais novos", () => {
    expect(crmFindFreeSlots.description).toMatch(/agenda_desatualizada/);
    expect(crmFindFreeSlots.description).toMatch(/sem_hoje/);
  });
});
