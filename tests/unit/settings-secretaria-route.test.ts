// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configDaSecretariaPatchSchema, lerConfigDaSecretaria } from "@/lib/agenda/secretaria/config";

/**
 * A ROTA da configuração da secretaria: o gate de papel, a validação do corpo, o dono da agenda ser da equipe e o
 * merge NÃO destrutivo (preserva as demais chaves de `settings` e as validades que a tela não conhece).
 */
const requireRole = vi.fn();
const audit = vi.fn();
const admin = { from: vi.fn() };
const lerSituacao = vi.fn();

vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ sessao: true }) }));
vi.mock("@/lib/agenda/secretaria/situacao", () => ({ lerSituacaoDaSecretaria: (...a: unknown[]) => lerSituacao(...a) }));

const { GET, PATCH } = await import("@/app/api/v1/settings/secretaria/route");

const ORG = "0be7a70a-0000-4000-8000-000000000001";
const DONO = "11111111-1111-4111-8111-111111111111";
const autorizado = { ok: true, user: { id: "u-1" }, org: { orgId: ORG, role: "manager" } };

function corpo(b: unknown) {
  return new Request("http://localhost/api/v1/settings/secretaria", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  }) as never;
}

/** Cliente administrativo falso: membro devolvido, settings atual, e o que foi gravado. */
function montarAdmin(opts: { membro?: { role: string } | null; settings?: unknown }) {
  const gravado: { settings?: unknown } = {};
  admin.from.mockImplementation((tabela: string) => {
    if (tabela === "user_organizations") {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.membro ?? null, error: null }) }) }) }) };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: opts.settings ?? {} }, error: null }) }) }),
      update: (v: { settings: unknown }) => {
        gravado.settings = v.settings;
        return { eq: async () => ({ error: null }) };
      },
    };
  });
  return gravado;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue(autorizado);
});

describe("o schema do PATCH", () => {
  it("aceita um pedaço (tudo é opcional)", () => {
    expect(configDaSecretariaPatchSchema.parse({ ativa: true })).toEqual({ ativa: true });
  });

  it("campo desconhecido é erro, não é ignorado", () => {
    expect(configDaSecretariaPatchSchema.safeParse({ ativa: true, validade_hoje_horas: 1 }).success).toBe(false);
  });

  it("horário fora de HH:MM, repetido ou em excesso é recusado; a lista sai ordenada", () => {
    expect(configDaSecretariaPatchSchema.safeParse({ perguntas: ["8:30"] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ perguntas: ["08:30", "08:30"] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ perguntas: [] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ perguntas: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.parse({ perguntas: ["18:15", "08:30"] }).perguntas).toEqual(["08:30", "18:15"]);
  });

  it("dias: 0 a 6, sem repetir, ao menos um", () => {
    expect(configDaSecretariaPatchSchema.safeParse({ dias: [7] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ dias: [] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ dias: [1, 1] }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.parse({ dias: [5, 1, 3] }).dias).toEqual([1, 3, 5]);
  });

  it("duração entre 5 e 240 min", () => {
    expect(configDaSecretariaPatchSchema.safeParse({ duracao_min: 4 }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ duracao_min: 241 }).success).toBe(false);
    expect(configDaSecretariaPatchSchema.safeParse({ duracao_min: 30 }).success).toBe(true);
  });
});

describe("GET", () => {
  it("exige gerente: o gate é chamado com 'manager' e a resposta de recusa é devolvida", async () => {
    const recusa = new Response("nao", { status: 403 });
    requireRole.mockResolvedValue({ ok: false, response: recusa });
    const r = await GET({} as never);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_secretaria" }));
    expect(r).toBe(recusa);
    expect(lerSituacao).not.toHaveBeenCalled();
  });

  it("devolve a configuração e as secretarias", async () => {
    lerSituacao.mockResolvedValue({
      config: { ativa: true, dono_da_agenda_user_id: null, duracao_min: 30, perguntas: ["08:30"], dias: [1] },
      secretarias: [{ id: "c1", nome: "Ana", tem_conversa: false }],
    });
    const r = await GET({} as never);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ ativa: true, secretarias: [{ nome: "Ana", tem_conversa: false }] });
  });
});

describe("PATCH", () => {
  it("exige gerente e não toca no banco quando recusa", async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response("nao", { status: 403 }) });
    const r = await PATCH(corpo({ ativa: true }));
    expect(r.status).toBe(403);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("corpo inválido: 422 e nada é gravado", async () => {
    const gravado = montarAdmin({});
    const r = await PATCH(corpo({ perguntas: ["8:30"] }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(gravado.settings).toBeUndefined();
  });

  it("liga e preserva as demais chaves de settings e as validades que a tela não conhece", async () => {
    const gravado = montarAdmin({
      settings: { routing: { mode: "manual" }, secretaria: { validade_hoje_horas: 3, ativa: false } },
    });
    const r = await PATCH(corpo({ ativa: true }));
    expect(r.status).toBe(200);
    expect(gravado.settings).toEqual({
      routing: { mode: "manual" },
      secretaria: { validade_hoje_horas: 3, ativa: true },
    });
    expect(lerConfigDaSecretaria(gravado.settings).validade_hoje_horas).toBe(3);
  });

  it("dono da agenda que não é da equipe: recusado e nada gravado", async () => {
    const gravado = montarAdmin({ membro: null });
    const r = await PATCH(corpo({ dono_da_agenda_user_id: DONO }));
    expect(r.status).toBe(422);
    expect(gravado.settings).toBeUndefined();
  });

  it("dono da agenda com papel de visualizador: recusado", async () => {
    const gravado = montarAdmin({ membro: { role: "viewer" } });
    const r = await PATCH(corpo({ dono_da_agenda_user_id: DONO }));
    expect(r.status).toBe(422);
    expect(gravado.settings).toBeUndefined();
  });

  it("dono da agenda atendente: aceito e gravado", async () => {
    const gravado = montarAdmin({ membro: { role: "agent" } });
    const r = await PATCH(corpo({ dono_da_agenda_user_id: DONO }));
    expect(r.status).toBe(200);
    expect(gravado.settings).toEqual({ secretaria: { dono_da_agenda_user_id: DONO } });
  });

  it("tirar o dono (null) não consulta membros", async () => {
    montarAdmin({ settings: { secretaria: { dono_da_agenda_user_id: DONO } } });
    const r = await PATCH(corpo({ dono_da_agenda_user_id: null }));
    expect(r.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith("user_organizations");
  });

  it("audita com o ator e os NOMES dos campos, não os valores", async () => {
    montarAdmin({});
    await PATCH(corpo({ ativa: true, perguntas: ["08:30"] }));
    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0]![0];
    expect(e).toMatchObject({ action: "secretaria.config_changed", actorUserId: "u-1", organizationId: ORG });
    expect(e.metadata).toEqual({ campos: ["ativa", "perguntas"], ativa: true });
  });
});
