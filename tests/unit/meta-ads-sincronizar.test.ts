import { beforeEach, describe, expect, it, vi } from "vitest";

const decifrar = vi.fn();
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: (...a: unknown[]) => decifrar(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { sincronizarOrganizacao } from "@/lib/meta-ads/sincronizar";

const ORG = "11111111-1111-4111-8111-111111111111";

interface Estado {
  conexao: Record<string, unknown> | null;
  atualizacoes: Array<Record<string, unknown>>;
  upserts: Array<{ linhas: Array<Record<string, unknown>>; opcoes: unknown }>;
  erroNoUpsert: boolean;
}

function adminFalso(estado: Estado) {
  return {
    from: (tabela: string) => {
      if (tabela === "meta_ads_conexoes") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: estado.conexao, error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            estado.atualizacoes.push(patch);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      return {
        upsert: async (linhas: Array<Record<string, unknown>>, opcoes: unknown) => {
          estado.upserts.push({ linhas, opcoes });
          return { error: estado.erroNoUpsert ? { message: "boom" } : null };
        },
      };
    },
  } as never;
}

const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const linha = (extra: Record<string, unknown> = {}) => ({
  ad_id: "120210000000000",
  ad_name: "Anúncio",
  spend: "10.00",
  impressions: "100",
  clicks: "5",
  date_start: "2026-11-08",
  ...extra,
});

let estado: Estado;
beforeEach(() => {
  decifrar.mockReset().mockResolvedValue("chave-em-claro");
  estado = {
    conexao: { ad_account_id: "1234567", currency: "BRL", token_encrypted: "\\xabc", last_synced_at: "2026-11-08T10:00:00Z" },
    atualizacoes: [],
    upserts: [],
    erroNoUpsert: false,
  };
});

describe("sincronizarOrganizacao", () => {
  it("lê, grava com a organização na linha e marca conectada com a hora", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: [linha(), linha({ ad_id: "x" })] }));
    const agora = new Date("2026-11-09T12:00:00Z");
    const r = await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never, agora });
    expect(r).toEqual({ ok: true, linhas: 1, descartadas: 1 });
    expect(estado.upserts[0]!.linhas[0]).toMatchObject({ organization_id: ORG, ad_id: "120210000000000", spend_cents: 1000 });
    expect(estado.upserts[0]!.opcoes).toEqual({ onConflict: "organization_id,dia,ad_id" });
    expect(estado.atualizacoes.at(-1)).toMatchObject({ status: "conectada", last_error: null, last_synced_at: agora.toISOString() });
  });

  it("grava as conversas iniciadas que a Meta informou junto com o gasto", async () => {
    const actions = [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "9" }];
    const f = vi.fn().mockResolvedValue(resposta({ data: [linha({ actions })] }));
    await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never, agora: new Date("2026-11-09T12:00:00Z") });
    expect(estado.upserts[0]!.linhas[0]).toMatchObject({ conversations: 9, spend_cents: 1000 });
  });

  it("a PRIMEIRA vez lê 90 dias; as seguintes, 35", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: [] }));
    const agora = new Date("2026-11-09T12:00:00Z");
    estado.conexao!.last_synced_at = null;
    await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never, agora });
    const primeira = JSON.parse(new URL(String(f.mock.calls[0]![0])).searchParams.get("time_range")!);
    expect(primeira).toEqual({ since: "2026-08-11", until: "2026-11-09" });

    estado.conexao!.last_synced_at = "2026-11-08T10:00:00Z";
    await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never, agora });
    const seguinte = JSON.parse(new URL(String(f.mock.calls[1]![0])).searchParams.get("time_range")!);
    expect(seguinte).toEqual({ since: "2026-10-05", until: "2026-11-09" });
  });

  it("chave recusada pela Meta: marca token_invalido com frase em português e NÃO grava gasto", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ error: { code: 190, message: "cru" } }, 400));
    const r = await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never });
    expect(r).toEqual({ ok: false, erro: "token_invalido" });
    expect(estado.upserts).toHaveLength(0);
    const ultimo = estado.atualizacoes.at(-1)!;
    expect(ultimo.status).toBe("token_invalido");
    expect(String(ultimo.last_error)).toContain("Meta recusou a chave");
    expect(String(ultimo.last_error)).not.toContain("cru");
    expect(ultimo).not.toHaveProperty("last_synced_at");
  });

  it("chave guardada que não decifra: marca erro e nem chama a Meta", async () => {
    decifrar.mockResolvedValue(null);
    const f = vi.fn();
    const r = await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never });
    expect(r).toEqual({ ok: false, erro: "chave_ilegivel" });
    expect(f).not.toHaveBeenCalled();
    expect(estado.atualizacoes.at(-1)!.status).toBe("erro");
  });

  it("falha ao gravar: marca erro e não finge sucesso", async () => {
    estado.erroNoUpsert = true;
    const f = vi.fn().mockResolvedValue(resposta({ data: [linha()] }));
    const r = await sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never });
    expect(r).toEqual({ ok: false, erro: "gravacao" });
    expect(estado.atualizacoes.at(-1)!.status).toBe("erro");
  });

  it("organização sem conexão: nada a fazer", async () => {
    estado.conexao = null;
    const f = vi.fn();
    await expect(sincronizarOrganizacao(adminFalso(estado), ORG, { fetcher: f as never })).resolves.toEqual({
      ok: false,
      erro: "sem_conexao",
    });
    expect(f).not.toHaveBeenCalled();
  });
});
