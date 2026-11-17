import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ROTA DO CRON DAS PERGUNTAS À SECRETARIA — auth, resultado e auditoria.
 *
 * A regra de horário está em `bastidor-secretaria-perguntas.test.ts` e o roteiro do tick em
 * `bastidor-secretaria-perguntas-tick.test.ts`; aqui só se prova o que é da ROTA:
 *
 *   1. fail-closed: sem o segredo certo o banco nem é tocado;
 *   2. devolve a contagem do tick;
 *   3. falha do tick vira 500, sem vazar a mensagem;
 *   4. só audita quando FEZ algo, e a auditoria leva contagens, nunca nome nem telefone.
 */
const executar = vi.fn();
const audit = vi.fn();
const portasDoTick = vi.fn();
const erroDeLog = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/bastidor/secretaria/perguntas-supabase", () => ({ portasDoTickNoSupabase: (...a: unknown[]) => portasDoTick(...a) }));
vi.mock("@/lib/bastidor/secretaria/perguntas-tick", () => ({ executarTickDasPerguntas: (...a: unknown[]) => executar(...a) }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "s3cr3t", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: erroDeLog } }));

const { GET, POST } = await import("@/app/api/v1/cron/secretaria-agenda/route");

const requisicao = (segredo: string | null = "s3cr3t") =>
  new Request("http://localhost/api/v1/cron/secretaria-agenda", {
    headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
  }) as never;

const VAZIO = { secretarias: 1, perguntadas: 0, dispensadas: 0, lembradas: 0, avisos: 0, respondidas: 0, erros: 0 };

beforeEach(() => {
  executar.mockReset();
  audit.mockReset();
  portasDoTick.mockReset();
  erroDeLog.mockReset();
  portasDoTick.mockReturnValue({ portas: true });
  executar.mockResolvedValue(VAZIO);
});

describe("auth — fail-closed", () => {
  it("sem segredo: 403 e nada é executado", async () => {
    const r = await GET(requisicao(null));
    expect(r.status).toBe(403);
    expect(executar).not.toHaveBeenCalled();
    expect(portasDoTick).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await GET(requisicao("outro"))).status).toBe(403);
    expect(executar).not.toHaveBeenCalled();
  });

  it("POST obedece à mesma regra", async () => {
    expect((await POST(requisicao(null))).status).toBe(403);
    expect((await POST(requisicao())).status).toBe(200);
  });
});

describe("o tick", () => {
  it("executa com as portas do banco e devolve a contagem", async () => {
    executar.mockResolvedValue({ ...VAZIO, perguntadas: 1 });
    const r = await GET(requisicao());
    expect(executar).toHaveBeenCalledWith({ portas: true });
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(JSON.stringify(corpo)).toContain('"perguntadas":1');
  });

  it("o tick que quebra vira 500 e a mensagem do erro não vai para quem chamou", async () => {
    executar.mockRejectedValue(new Error("senha do banco: abc"));
    const r = await GET(requisicao());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("senha do banco");
    expect(erroDeLog).toHaveBeenCalled();
  });
});

describe("auditoria", () => {
  it("tick que não fez nada: não audita", async () => {
    await GET(requisicao());
    expect(audit).not.toHaveBeenCalled();
  });

  it("tick que perguntou: audita com contagens e sem organização (roda para todas)", async () => {
    executar.mockResolvedValue({ ...VAZIO, perguntadas: 2, avisos: 1 });
    await GET(requisicao());
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = audit.mock.calls[0]![0];
    expect(entrada.action).toBe("agenda.secretaria_perguntas_executadas");
    expect(entrada.organizationId).toBeNull();
    expect(entrada.metadata).toMatchObject({ perguntadas: 2, avisos: 1 });
  });

  it("só respondida/erro (nada enviado): não audita", async () => {
    executar.mockResolvedValue({ ...VAZIO, respondidas: 2, erros: 1 });
    await GET(requisicao());
    expect(audit).not.toHaveBeenCalled();
  });
});
