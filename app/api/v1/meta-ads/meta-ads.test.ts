// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

let papelOk = true;
let conexaoNoBanco: Record<string, unknown> | null = null;
const upserts: Array<Record<string, unknown>> = [];
const apagados: Array<{ coluna: string; valor: unknown }> = [];
const selects: string[] = [];
const auditorias: Array<Record<string, unknown>> = [];
let cifra: string | null = "\\xcifrado";
let contaOuErro: { nome: string | null; moeda: string | null } | "token_invalido" | "indisponivel" = {
  nome: "Clínica Sorriso",
  moeda: "BRL",
};
const chamadasAConta: Array<{ conta: string; chave: string }> = [];
let sincronizacao: { ok: true; linhas: number; descartadas: number } | { ok: false; erro: string } = {
  ok: true,
  linhas: 3,
  descartadas: 0,
};
let sincronizacoes = 0;

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    papelOk
      ? { ok: true, user: { id: "u-1" }, org: { orgId: "org-1" } }
      : { ok: false, response: new Response(null, { status: 403 }) },
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void auditorias.push(e) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => cifra }));
vi.mock("@/lib/channels/meta/ads-graph", async (original) => {
  const real = await original<typeof import("@/lib/channels/meta/ads-graph")>();
  return {
    ...real,
    lerConta: async (conta: string, chave: string) => {
      chamadasAConta.push({ conta, chave });
      if (typeof contaOuErro === "string") throw new real.MetaAdsError(contaOuErro);
      return contaOuErro;
    },
  };
});
vi.mock("@/lib/meta-ads/sincronizar", async (original) => {
  const real = await original<typeof import("@/lib/meta-ads/sincronizar")>();
  return {
    ...real,
    sincronizarOrganizacao: async () => {
      sincronizacoes += 1;
      return sincronizacao;
    },
  };
});
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-interno", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (colunas: string) => {
          selects.push(colunas);
          return b;
        },
        eq: (coluna: string, valor: unknown) => {
          apagados.push({ coluna, valor });
          return b;
        },
        in: () => b,
        order: () => b,
        limit: async () => ({ data: [{ organization_id: "org-1" }, { organization_id: "org-2" }], error: null }),
        maybeSingle: async () => ({ data: conexaoNoBanco, error: null }),
        upsert: async (linha: Record<string, unknown>) => {
          upserts.push(linha);
          conexaoNoBanco = { ad_account_id: linha.ad_account_id, account_name: linha.account_name, currency: linha.currency, status: "conectada", last_synced_at: null, last_error: null };
          return { error: null };
        },
        delete: () => b,
        then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r),
      });
      return b;
    },
  }),
}));

import { GET as cron } from "../cron/meta-ads-sync/route";
import { DELETE, GET, PUT } from "./conexao/route";
import { POST as sincronizar } from "./sincronizar/route";

const put = (corpo: unknown) =>
  PUT(new Request("http://localhost/api/v1/meta-ads/conexao", { method: "PUT", body: JSON.stringify(corpo) }) as never);

const CHAVE = "EAABsbCS1iHgBO".padEnd(40, "x");

beforeEach(() => {
  papelOk = true;
  conexaoNoBanco = null;
  upserts.length = 0;
  apagados.length = 0;
  selects.length = 0;
  auditorias.length = 0;
  chamadasAConta.length = 0;
  cifra = "\\xcifrado";
  contaOuErro = { nome: "Clínica Sorriso", moeda: "BRL" };
  sincronizacao = { ok: true, linhas: 3, descartadas: 0 };
  sincronizacoes = 0;
});

describe("/api/v1/meta-ads/conexao", () => {
  it("só gestor+: sem o papel, 403 em GET, PUT e DELETE", async () => {
    papelOk = false;
    expect((await GET()).status).toBe(403);
    expect((await put({ ad_account_id: "1234567", token: CHAVE })).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it("GET sem conexão: conectada=false; com conexão: só colunas públicas, NUNCA a chave", async () => {
    const vazio = await (await GET()).json();
    expect(vazio.data).toMatchObject({ conectada: false, ad_account_id: null });

    conexaoNoBanco = { ad_account_id: "1234567", account_name: "X", currency: "BRL", status: "conectada", last_synced_at: null, last_error: null };
    const r = await (await GET()).json();
    expect(r.data).toMatchObject({ conectada: true, ad_account_id: "1234567" });
    expect(selects.at(-1)).not.toContain("token");
    expect(JSON.stringify(r)).not.toContain("token");
  });

  it("PUT com dados inválidos: 422, nada é guardado e a chave digitada NÃO volta na resposta", async () => {
    const r = await put({ ad_account_id: "abc", token: "curta com espaço" });
    expect(r.status).toBe(422);
    expect(upserts).toHaveLength(0);
    expect(await r.text()).not.toContain("curta com espaço");
    expect(chamadasAConta).toHaveLength(0);
  });

  it("PUT feliz: confere na Meta, grava CIFRADA e para a organização ativa (nunca a do corpo), sem devolver a chave", async () => {
    const r = await put({ ad_account_id: "act_1234567", token: CHAVE, organization_id: "org-INVASORA" });
    expect(r.status).toBe(200);
    expect(chamadasAConta).toEqual([{ conta: "1234567", chave: CHAVE }]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      organization_id: "org-1",
      ad_account_id: "1234567",
      account_name: "Clínica Sorriso",
      currency: "BRL",
      token_encrypted: "\\xcifrado",
      status: "conectada",
      updated_by: "u-1",
    });
    expect(JSON.stringify(upserts[0])).not.toContain(CHAVE);
    const texto = await r.text();
    expect(texto).not.toContain(CHAVE);
    expect(texto).not.toContain("token");
    expect(auditorias[0]).toMatchObject({ action: "meta_ads.conectada", organizationId: "org-1", actorUserId: "u-1" });
    expect(JSON.stringify(auditorias[0])).not.toContain(CHAVE);
  });

  it("chave recusada pela Meta: 422 com a frase em português e nada é guardado", async () => {
    contaOuErro = "token_invalido";
    const r = await put({ ad_account_id: "1234567", token: CHAVE });
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toContain("Meta recusou a chave");
    expect(upserts).toHaveLength(0);
    expect(auditorias).toHaveLength(0);
  });

  it("Meta fora do ar: 502, nada é guardado", async () => {
    contaOuErro = "indisponivel";
    expect((await put({ ad_account_id: "1234567", token: CHAVE })).status).toBe(502);
    expect(upserts).toHaveLength(0);
  });

  it("sem a cifra da instalação: RECUSA — nunca grava a chave em claro", async () => {
    cifra = null;
    const r = await put({ ad_account_id: "1234567", token: CHAVE });
    expect(r.status).toBe(422);
    expect(upserts).toHaveLength(0);
  });

  it("DELETE apaga só a conexão da organização ativa e registra quem desconectou", async () => {
    const r = await DELETE();
    expect(r.status).toBe(200);
    expect(apagados).toContainEqual({ coluna: "organization_id", valor: "org-1" });
    expect(auditorias[0]).toMatchObject({ action: "meta_ads.desconectada", organizationId: "org-1" });
  });
});

describe("POST /api/v1/meta-ads/sincronizar", () => {
  const chamar = () => sincronizar();

  it("sem papel de gestor: 403 e a Meta não é chamada", async () => {
    papelOk = false;
    expect((await chamar()).status).toBe(403);
    expect(sincronizacoes).toBe(0);
  });

  it("sem conexão: 404", async () => {
    expect((await chamar()).status).toBe(404);
  });

  it("atualizado há menos de 2 minutos: não chama a Meta de novo", async () => {
    conexaoNoBanco = { last_synced_at: new Date(Date.now() - 30_000).toISOString() };
    const r = await (await chamar()).json();
    expect(r.data).toMatchObject({ atualizou: false, jaAtualizado: true });
    expect(sincronizacoes).toBe(0);
  });

  it("atualiza e devolve a contagem", async () => {
    conexaoNoBanco = { last_synced_at: new Date(Date.now() - 3_600_000).toISOString() };
    const r = await (await chamar()).json();
    expect(r.data).toMatchObject({ atualizou: true, linhas: 3 });
    expect(sincronizacoes).toBe(1);
  });

  it("falha da Meta: 200 com a frase pronta (não é falha nossa)", async () => {
    conexaoNoBanco = { last_synced_at: null };
    sincronizacao = { ok: false, erro: "token_invalido" };
    const r = await chamar();
    expect(r.status).toBe(200);
    expect((await r.json()).data.mensagem).toContain("Meta recusou a chave");
  });
});

describe("cron meta-ads-sync", () => {
  const rodar = (auth?: string) =>
    cron(new Request("http://localhost/api/v1/cron/meta-ads-sync", { headers: auth ? { authorization: auth } : {} }) as never);

  it("sem o segredo interno: 403 e nada é sincronizado", async () => {
    expect((await rodar()).status).toBe(403);
    expect((await rodar("Bearer errado")).status).toBe(403);
    expect(sincronizacoes).toBe(0);
  });

  it("com o segredo: sincroniza cada organização e conta o resultado", async () => {
    const r = await (await rodar("Bearer segredo-interno")).json();
    expect(r.data).toEqual({ organizacoes: 2, sincronizadas: 2, falharam: 0 });
    expect(sincronizacoes).toBe(2);
  });

  it("a falha de uma organização não impede as outras", async () => {
    sincronizacao = { ok: false, erro: "limite" };
    const r = await (await rodar("Bearer segredo-interno")).json();
    expect(r.data).toEqual({ organizacoes: 2, sincronizadas: 0, falharam: 2 });
  });
});
