// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

let papelOk = true;
const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
const respostas: Record<string, { data: unknown; error: { message: string } | null }> = {};
const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    papelOk
      ? { ok: true, user: { id: "u-1" }, org: { orgId: "org-1" } }
      : { ok: false, response: new Response(null, { status: 403 }) },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return respostas[nome] ?? { data: [], error: null };
    },
    from(tabela: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ tabela, coluna, valor });
          return b;
        },
        then: (r: (v: unknown) => void) => Promise.resolve(respostas[tabela] ?? { data: [], error: null }).then(r),
      });
      return b;
    },
  }),
}));

import { GET as origens } from "./origens/route";
import { GET as funilDosQrs } from "./qr-codes/route";

const pedir = (rota: typeof origens, qs: string) =>
  rota(new Request(`http://localhost/api/v1/relatorios/x?${qs}`) as never);

beforeEach(() => {
  papelOk = true;
  rpcs.length = 0;
  filtros.length = 0;
  for (const k of Object.keys(respostas)) delete respostas[k];
});

describe("GET /api/v1/relatorios/origens", () => {
  it("sem papel de gestor: 403 e o banco nem é consultado", async () => {
    papelOk = false;
    expect((await pedir(origens, "de=2026-10-01&ate=2026-10-07")).status).toBe(403);
    expect(rpcs).toHaveLength(0);
  });

  it("período ausente, invertido ou grande demais: 422", async () => {
    expect((await pedir(origens, "")).status).toBe(422);
    expect((await pedir(origens, "de=2026-10-07&ate=2026-10-01")).status).toBe(422);
    expect((await pedir(origens, "de=2025-01-01&ate=2026-12-31")).status).toBe(422);
    expect(rpcs).toHaveLength(0);
  });

  it("pede ao banco a ORGANIZAÇÃO ATIVA e a janela em instantes (ate exclusivo, no fuso)", async () => {
    await pedir(origens, "de=2026-10-01&ate=2026-10-03&fuso=America/Sao_Paulo");
    const r = rpcs.find((c) => c.nome === "fn_relatorio_de_origens")!;
    expect(r.args).toEqual({
      p_org: "org-1",
      p_de: "2026-10-01T03:00:00.000Z",
      p_ate: "2026-10-04T03:00:00.000Z",
    });
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "organization_id", valor: "org-1" });
    expect(filtros).toContainEqual({ tabela: "webhook_sources", coluna: "organization_id", valor: "org-1" });
  });

  it("converte os bigint (que chegam como string) e agrupa com o nome do QR de hoje", async () => {
    respostas.fn_relatorio_de_origens = {
      data: [
        { source: "qr_code", detalhe: "qr-1", leads: "5", abertos: "3", ganhos: "1", perdidos: "1", valor_ganho_cents: "10000" },
        { source: "whatsapp", detalhe: null, leads: "2", abertos: "2", ganhos: "0", perdidos: "0", valor_ganho_cents: "0" },
      ],
      error: null,
    };
    respostas.fn_relatorio_de_origens_por_dia = { data: [{ dia: "2026-10-02", source: "qr_code", leads: "5" }], error: null };
    respostas.qr_codes = { data: [{ id: "qr-1", nome: "Cartaz da recepção" }], error: null };

    const r = await pedir(origens, "de=2026-10-01&ate=2026-10-03");
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data.total).toMatchObject({ leads: 7, ganhos: 1, valorGanhoCents: 10000, conversao: 0.5 });
    expect(data.grupos.map((g: { grupo: string }) => g.grupo)).toEqual(["qr", "whatsapp"]);
    expect(data.grupos[0].detalhes[0]).toMatchObject({ rotulo: "Cartaz da recepção", leads: 5 });
    expect(data.serie).toHaveLength(3);
    expect(data.serie[1]).toMatchObject({ dia: "2026-10-02", qr: 5 });
  });

  it("erro do banco vira 500 com a mensagem, não um relatório vazio", async () => {
    respostas.fn_relatorio_de_origens = { data: null, error: { message: "boom" } };
    expect((await pedir(origens, "de=2026-10-01&ate=2026-10-03")).status).toBe(500);
  });
});

describe("GET /api/v1/relatorios/qr-codes", () => {
  it("sem papel de gestor: 403", async () => {
    papelOk = false;
    expect((await pedir(funilDosQrs, "de=2026-10-01&ate=2026-10-07")).status).toBe(403);
    expect(rpcs).toHaveLength(0);
  });

  it("período inválido: 422", async () => {
    expect((await pedir(funilDosQrs, "de=x&ate=y")).status).toBe(422);
  });

  it("devolve o funil com números convertidos", async () => {
    respostas.fn_relatorio_de_qr_codes = {
      data: [{ qr_code_id: "qr-1", leituras: "120", conversas: "30", leads: "22", ganhos: "5", valor_ganho_cents: "500000" }],
      error: null,
    };
    const r = await pedir(funilDosQrs, "de=2026-10-01&ate=2026-10-07");
    expect(r.status).toBe(200);
    expect((await r.json()).data.funil).toEqual([
      { qr_code_id: "qr-1", leituras: 120, conversas: 30, leads: 22, ganhos: 5, valor_ganho_cents: 500000 },
    ]);
    expect(rpcs[0]!.args).toMatchObject({ p_org: "org-1" });
  });
});
