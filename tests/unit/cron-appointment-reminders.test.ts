import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ROTA DO CRON DO LEMBRETE — auth, fila, isolamento entre compromissos e auditoria.
 *
 * A regra de cada compromisso está em `agenda-lembrete-executar.test.ts` e em
 * `lib/agenda/lembrete/*.test.ts`; aqui só se prova o que é da ROTA:
 *
 *   1. fail-closed: sem o segredo certo nada é lido nem enviado;
 *   2. pede ao banco os devidos com o relógio de agora e o teto de 30;
 *   3. um compromisso que quebra NÃO derruba os outros do mesmo tick;
 *   4. só audita quando FEZ algo, e a auditoria leva contagens, nunca ids de gente.
 */

const rpc = vi.fn();
const audit = vi.fn();
const processar = vi.fn();
const erroDeLog = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/agenda/lembrete/portas-supabase", () => ({
  portasDoSupabase: () => ({ agora: () => new Date("2026-10-25T17:05:00Z") }),
}));
vi.mock("@/lib/agenda/lembrete/executar", () => ({ processarLembrete: processar }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "s3cr3t", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: erroDeLog } }));

const { GET, POST } = await import("@/app/api/v1/cron/appointment-reminders/route");

const requisicao = (segredo: string | null = "s3cr3t") =>
  new Request("http://localhost/api/v1/cron/appointment-reminders", {
    headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
  }) as never;

const devidos = (...ids: string[]) =>
  ids.map((id) => ({ appointment_id: id, organization_id: "org-1" }));

beforeEach(() => {
  rpc.mockReset();
  audit.mockReset();
  processar.mockReset();
  erroDeLog.mockReset();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("auth — fail-closed", () => {
  it("sem segredo: 403 e o banco nem é consultado", async () => {
    const r = await GET(requisicao(null));
    expect(r.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await GET(requisicao("outro"))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("POST obedece à mesma regra (curl de quem opera à mão)", async () => {
    expect((await POST(requisicao(null))).status).toBe(403);
    expect((await POST(requisicao())).status).toBe(200);
  });
});

describe("a fila", () => {
  it("pede ao banco os devidos agora, com o teto de 30 por tick", async () => {
    await GET(requisicao());
    expect(rpc).toHaveBeenCalledWith("fn_lembretes_devidos", {
      p_now: "2026-10-25T17:05:00.000Z",
      p_limit: 30,
    });
  });

  it("falha ao consultar o banco: 500, e nada é processado", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const r = await GET(requisicao());
    expect(r.status).toBe(500);
    expect(processar).not.toHaveBeenCalled();
  });

  it("entrega a cada compromisso o par (id, organização) que o banco devolveu", async () => {
    rpc.mockResolvedValue({ data: devidos("a1", "a2"), error: null });
    processar.mockResolvedValue("esperando");
    await GET(requisicao());
    expect(processar.mock.calls.map((c) => c[1])).toEqual([
      { id: "a1", organizationId: "org-1" },
      { id: "a2", organizationId: "org-1" },
    ]);
  });
});

describe("isolamento entre compromissos", () => {
  it("o que quebra é contado e logado; os outros seguem", async () => {
    rpc.mockResolvedValue({ data: devidos("a1", "a2", "a3"), error: null });
    processar
      .mockResolvedValueOnce("enviado")
      .mockRejectedValueOnce(new Error("rede caiu"))
      .mockResolvedValueOnce("enviado");

    const r = await GET(requisicao());
    const corpo = (await r.json()) as { data: Record<string, number> };

    expect(r.status).toBe(200);
    expect(processar).toHaveBeenCalledTimes(3);
    expect(corpo.data).toMatchObject({ varridos: 3, enviado: 2, erro: 1 });
    expect(erroDeLog).toHaveBeenCalledWith(
      "[appointment-reminders] compromisso falhou",
      expect.objectContaining({ appointmentId: "a2", error: "rede caiu" }),
    );
  });
});

describe("auditoria", () => {
  it("só espera: nada é auditado", async () => {
    rpc.mockResolvedValue({ data: devidos("a1", "a2"), error: null });
    processar.mockResolvedValue("esperando");
    await GET(requisicao());
    expect(audit).not.toHaveBeenCalled();
  });

  it("lista vazia: nada é auditado", async () => {
    await GET(requisicao());
    expect(audit).not.toHaveBeenCalled();
  });

  it("enviou, descartou ou desistiu: audita UMA vez, com contagens e sem ids", async () => {
    rpc.mockResolvedValue({ data: devidos("a1", "a2", "a3", "a4"), error: null });
    processar
      .mockResolvedValueOnce("enviado")
      .mockResolvedValueOnce("pulado")
      .mockResolvedValueOnce("falhou")
      .mockResolvedValueOnce("esperando");

    await GET(requisicao());

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = audit.mock.calls[0]![0];
    expect(entrada.action).toBe("agenda.lembretes_executados");
    expect(entrada.metadata).toEqual({
      varridos: 4,
      enviado: 1,
      pulado: 1,
      falhou: 1,
      esperando: 1,
      ignorado: 0,
      erro: 0,
    });
    expect(JSON.stringify(entrada)).not.toContain("a1");
  });
});
