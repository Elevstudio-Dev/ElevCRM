import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ROTA DOS TIPOS DE AGENDAMENTO ACEITA, VALIDA E PUBLICA O LEMBRETE.
 *
 * Antes da 0217 as colunas de lembrete existiam no banco e NENHUMA rota as lia ou
 * escrevia: não havia como ligar o lembrete de um tipo senão por SQL. O que se prova aqui
 * é a fronteira — os limites do que a clínica pode pedir, e a recusa do modelo que o cron
 * não saberia enviar (descobrir no envio é descobrir com o paciente já sem aviso).
 */

const atualizacoes: Array<{ campos: Record<string, unknown>; filtros: Array<[string, unknown]> }> = [];
const insercoes: Array<Record<string, unknown>> = [];
const conferir = vi.fn();
const audit = vi.fn(async (_entrada: Record<string, unknown>): Promise<void> => undefined);

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: "org-1" } })),
}));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/agenda/lembrete/modelo-do-tipo", () => ({ conferirModeloEscolhido: conferir }));
vi.mock("@/lib/agenda/consulta", () => ({
  listaTiposDeAtendimento: vi.fn(async () => ({
    ok: true,
    tipos: [
      {
        id: "tp-1",
        nome: "Avaliação",
        slug: "avaliacao",
        descricao: null,
        categoria: "consulta",
        duracaoMin: 30,
        localKind: "in_person",
        localDetalhes: null,
        donoPadraoId: "u-1",
        precisaConfirmacao: false,
        ativo: true,
        bufferAntesMin: 0,
        bufferDepoisMin: 0,
        antecedenciaMinimaMin: 120,
        janelaDeAgendamentoDias: 60,
        lembreteLigado: true,
        lembreteAntecedenciaMin: 1440,
        lembreteModelo: "lembrete_consulta",
      },
    ],
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: (campos: Record<string, unknown>) => {
        const filtros: Array<[string, unknown]> = [];
        atualizacoes.push({ campos, filtros });
        const cadeia = {
          eq: (c: string, v: unknown) => {
            filtros.push([c, v]);
            return cadeia;
          },
          select: () => cadeia,
          maybeSingle: async () => ({ data: { id: "tp-1" }, error: null }),
        };
        return cadeia;
      },
      insert: (linha: Record<string, unknown>) => {
        insercoes.push(linha);
        return { select: () => ({ single: async () => ({ data: { id: "novo", slug: "novo" }, error: null }) }) };
      },
    }),
  }),
}));

const { GET, PATCH, POST } = await import("@/app/api/v1/agenda/tipos/route");

const corpo = (b: unknown) =>
  new Request("http://localhost/api/v1/agenda/tipos", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  }) as never;

const UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  atualizacoes.length = 0;
  insercoes.length = 0;
  conferir.mockReset();
  conferir.mockResolvedValue({ ok: true });
  audit.mockClear();
});

describe("GET publica a configuração do lembrete", () => {
  it("traz ligado, antecedência e modelo, no wire snake_case que a tela consome", async () => {
    const r = await GET(new Request("http://localhost/api/v1/agenda/tipos") as never);
    const corpoDaResposta = (await r.json()) as { data: Array<Record<string, unknown>> };
    expect(corpoDaResposta.data[0]).toMatchObject({
      reminder_enabled: true,
      reminder_minutes_before: 1440,
      reminder_template_name: "lembrete_consulta",
    });
  });
});

describe("PATCH — os limites do que a clínica pode pedir", () => {
  it.each([0, 30, 59])("antecedência de %i min é recusada (menos de 1 h o cron descarta por 'tarde demais')", async (min) => {
    const r = await PATCH(corpo({ id: UUID, reminder_minutes_before: min }));
    expect(r.status).toBe(422);
    expect(atualizacoes).toHaveLength(0);
  });

  it("mais de sete dias antes é recusado", async () => {
    expect((await PATCH(corpo({ id: UUID, reminder_minutes_before: 10_081 }))).status).toBe(422);
    expect(atualizacoes).toHaveLength(0);
  });

  it.each([60, 120, 1440, 10_080])("%i min está dentro dos limites", async (min) => {
    expect((await PATCH(corpo({ id: UUID, reminder_minutes_before: min }))).status).toBe(200);
  });

  it("reminder_enabled tem de ser booleano — 'on' do formulário não vale como true", async () => {
    expect((await PATCH(corpo({ id: UUID, reminder_enabled: "on" }))).status).toBe(422);
    expect(atualizacoes).toHaveLength(0);
  });
});

describe("PATCH — o modelo escolhido", () => {
  it("liga o lembrete com um modelo que serve: grava os três campos, na organização certa", async () => {
    const r = await PATCH(
      corpo({
        id: UUID,
        reminder_enabled: true,
        reminder_minutes_before: 1440,
        reminder_template_name: "lembrete_consulta",
      }),
    );
    expect(r.status).toBe(200);
    expect(conferir).toHaveBeenCalledWith(expect.anything(), "org-1", "lembrete_consulta");
    expect(atualizacoes[0]!.campos).toEqual({
      reminder_enabled: true,
      reminder_minutes_before: 1440,
      reminder_template_name: "lembrete_consulta",
    });
    expect(atualizacoes[0]!.filtros).toContainEqual(["organization_id", "org-1"]);
    // A mudança de configuração é auditada, com os nomes dos campos.
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: "agenda.tipo_alterado",
      metadata: { campos: ["reminder_enabled", "reminder_minutes_before", "reminder_template_name"] },
    });
  });

  it("modelo que o lembrete não sabe enviar: 422 com o motivo, e NADA é gravado", async () => {
    conferir.mockResolvedValue({ ok: false, mensagem: "O modelo «x» não serve para o lembrete: usa {{plano}}." });
    const r = await PATCH(corpo({ id: UUID, reminder_template_name: "x" }));
    expect(r.status).toBe(422);
    const corpoDaResposta = (await r.json()) as { error?: { message?: string }; message?: string };
    expect(JSON.stringify(corpoDaResposta)).toContain("não serve para o lembrete");
    expect(atualizacoes).toHaveLength(0);
  });

  it("null volta ao texto padrão: grava nulo e NÃO consulta modelo nenhum", async () => {
    const r = await PATCH(corpo({ id: UUID, reminder_template_name: null }));
    expect(r.status).toBe(200);
    expect(conferir).not.toHaveBeenCalled();
    expect(atualizacoes[0]!.campos).toEqual({ reminder_template_name: null });
  });

  it("omitir o modelo não o apaga nem o reconfere", async () => {
    await PATCH(corpo({ id: UUID, name: "Avaliação inicial" }));
    expect(conferir).not.toHaveBeenCalled();
    expect(atualizacoes[0]!.campos).toEqual({ name: "Avaliação inicial" });
  });
});

describe("POST — criar já com o lembrete", () => {
  const novo = (extra: Record<string, unknown>) =>
    new Request("http://localhost/api/v1/agenda/tipos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Limpeza",
        category: "procedimento",
        duration_minutes: 30,
        location_kind: "in_person",
        ...extra,
      }),
    }) as never;

  it("com modelo bom: cria e leva os campos do lembrete na linha", async () => {
    const r = await POST(novo({ reminder_enabled: true, reminder_template_name: "lembrete_consulta" }));
    expect(r.status).toBe(201);
    expect(insercoes[0]).toMatchObject({
      organization_id: "org-1",
      reminder_enabled: true,
      reminder_template_name: "lembrete_consulta",
    });
  });

  it("com modelo imprestável: 422 e nenhuma linha criada", async () => {
    conferir.mockResolvedValue({ ok: false, mensagem: "O modelo «x» não existe nesta organização." });
    const r = await POST(novo({ reminder_template_name: "x" }));
    expect(r.status).toBe(422);
    expect(insercoes).toHaveLength(0);
  });

  it("sem tocar no lembrete, o tipo nasce com o padrão do banco (desligado desde a 0194)", async () => {
    await POST(novo({}));
    expect(insercoes[0]).not.toHaveProperty("reminder_enabled");
  });
});
