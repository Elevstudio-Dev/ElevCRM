// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const leituras: Array<Record<string, unknown>> = [];
let qr: Record<string, unknown> | null = null;
let canal: Record<string, unknown> | null = null;
let permitido = true;

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: permitido })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: tabela === "qr_codes" ? qr : canal, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          leituras.push(linha);
          return { error: null };
        },
      };
      return builder;
    },
  }),
}));

import { GET } from "./route";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const chamar = (codigo: string, ua: string | null = IPHONE) =>
  GET(new Request(`http://localhost/q/${codigo}`, { headers: ua ? { "user-agent": ua } : {} }) as never, {
    params: Promise.resolve({ codigo }),
  });

beforeEach(() => {
  leituras.length = 0;
  permitido = true;
  qr = {
    id: "qr-1",
    organization_id: "org-1",
    codigo: "R7K2QH",
    mensagem: "Olá! Vi o cartaz",
    arquivado_em: null,
    channel_session_id: "canal-1",
  };
  canal = { phone_number: "+5511987654321" };
});

describe("GET /q/[codigo]", () => {
  it("conta a leitura e redireciona para o WhatsApp com a mensagem + código", async () => {
    const r = await chamar("r7k2qh");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      "https://wa.me/5511987654321?text=Ol%C3%A1!%20Vi%20o%20cartaz%20%23R7K2QH",
    );
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(leituras).toEqual([{ organization_id: "org-1", qr_code_id: "qr-1", dispositivo: "celular" }]);
  });

  it("robô de pré-visualização é redirecionado mas NÃO conta", async () => {
    const r = await chamar("R7K2QH", "WhatsApp/2.23.20.0 A");
    expect(r.status).toBe(302);
    expect(leituras).toHaveLength(0);
  });

  it("acima do limite redireciona mas não conta — o limitador protege o número, não bloqueia a pessoa", async () => {
    permitido = false;
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(302);
    expect(leituras).toHaveLength(0);
  });

  it("código malformado e QR inexistente: página 404, sem contar", async () => {
    expect((await chamar("ABC")).status).toBe(404);
    qr = null;
    expect((await chamar("R7K2QH")).status).toBe(404);
    expect(leituras).toHaveLength(0);
  });

  it("QR arquivado: 410 e não conta", async () => {
    qr = { ...qr, arquivado_em: "2026-10-01T00:00:00Z" };
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("não está mais ativo");
    expect(leituras).toHaveLength(0);
  });

  it("sem número de WhatsApp resolvível: 503 e não conta", async () => {
    canal = null;
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(503);
    expect(leituras).toHaveLength(0);
  });
});
