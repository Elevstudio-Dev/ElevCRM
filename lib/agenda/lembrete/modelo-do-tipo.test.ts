import { describe, expect, it } from "vitest";

import {
  avaliarModelo,
  conferirModeloEscolhido,
  escolherLinha,
  modelosParaEscolher,
  type LinhaDeModelo,
} from "./modelo-do-tipo";

const corpoBom = [
  { type: "BODY", text: "Olá {{1}}! {{4}}, {{2}} às {{3}}, com {{5}}." },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmo" }] },
];

const linha = (parcial: Partial<LinhaDeModelo>): LinhaDeModelo => ({
  name: "lembrete_consulta",
  language: "pt_BR",
  status: "APPROVED",
  components: corpoBom,
  parameter_format: "POSITIONAL",
  ...parcial,
});

describe("escolherLinha — a MESMA escolha na tela e no cron", () => {
  it("aprovada vence a que está em análise, mesmo em idioma pior", () => {
    const r = escolherLinha([
      { language: "pt_BR", status: "PENDING" },
      { language: "en", status: "APPROVED" },
    ]);
    expect(r).toEqual({ language: "en", status: "APPROVED" });
  });

  it("entre aprovadas, pt_BR vence", () => {
    const r = escolherLinha([
      { language: "en", status: "APPROVED" },
      { language: "pt_BR", status: "APPROVED" },
      { language: "pt", status: "APPROVED" },
    ]);
    expect(r?.language).toBe("pt_BR");
  });

  it("nenhuma linha: nulo", () => {
    expect(escolherLinha([])).toBeNull();
  });
});

describe("avaliarModelo", () => {
  it("aprovado e com só variáveis conhecidas: serve", () => {
    expect(avaliarModelo(linha({}))).toEqual({ serve: true });
  });

  it("não aprovado: não serve, e o status vai na explicação", () => {
    const r = avaliarModelo(linha({ status: "REJECTED" }));
    expect(r).toEqual({ serve: false, problema: expect.stringContaining("REJECTED") });
  });

  it("variável desconhecida: não serve, e a explicação nomeia a variável e o que é aceito", () => {
    const r = avaliarModelo(
      linha({
        parameter_format: "NAMED",
        components: [{ type: "BODY", text: "Olá {{nome}}, seu plano {{plano}}." }],
      }),
    );
    expect(r.serve).toBe(false);
    if (r.serve) return;
    expect(r.problema).toContain("{{plano}}");
    expect(r.problema).toContain("nome, data, hora");
  });
});

// ─── com o banco falso ───────────────────────────────────────────────────────

function clienteDe(linhas: LinhaDeModelo[] | null, erro = false) {
  const filtros: Array<[string, unknown]> = [];
  const cadeia = {
    select: () => cadeia,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return cadeia;
    },
    then: (ok: (v: unknown) => unknown) =>
      ok(erro ? { data: null, error: { message: "boom" } } : { data: linhas, error: null }),
  };
  return { cliente: { from: () => cadeia } as never, filtros };
}

describe("modelosParaEscolher", () => {
  it("devolve um por nome, já avaliado, em ordem alfabética, lendo SÓ a organização", async () => {
    const { cliente, filtros } = clienteDe([
      linha({ name: "zeta", status: "PENDING" }),
      linha({ name: "alfa" }),
      linha({ name: "alfa", language: "en" }),
    ]);
    const r = await modelosParaEscolher(cliente, "org-1");

    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(r.map((m) => m.nome)).toEqual(["alfa", "zeta"]);
    expect(r[0]).toMatchObject({ nome: "alfa", idioma: "pt_BR", serve: true });
    expect(r[1]).toMatchObject({ nome: "zeta", serve: false });
    expect(r[1]?.problema).toContain("PENDING");
  });

  it("sem modelos (canal sem templates): lista vazia, sem estourar", async () => {
    const { cliente } = clienteDe(null);
    expect(await modelosParaEscolher(cliente, "org-1")).toEqual([]);
  });
});

describe("conferirModeloEscolhido", () => {
  it("modelo bom: ok, com organização E nome no filtro", async () => {
    const { cliente, filtros } = clienteDe([linha({})]);
    expect(await conferirModeloEscolhido(cliente, "org-1", "lembrete_consulta")).toEqual({ ok: true });
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["name", "lembrete_consulta"]);
  });

  it("nome que não existe: manda sincronizar os modelos", async () => {
    const { cliente } = clienteDe([]);
    const r = await conferirModeloEscolhido(cliente, "org-1", "fantasma");
    expect(r).toEqual({ ok: false, mensagem: expect.stringContaining("Conexões → Oficial → Templates") });
  });

  it("modelo que não serve: a mensagem diz qual e por quê", async () => {
    const { cliente } = clienteDe([linha({ status: "PENDING" })]);
    const r = await conferirModeloEscolhido(cliente, "org-1", "lembrete_consulta");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensagem).toContain("«lembrete_consulta»");
    expect(r.mensagem).toContain("PENDING");
  });

  it("erro de leitura: recusa com mensagem genérica, nunca aprova no escuro", async () => {
    const { cliente } = clienteDe(null, true);
    const r = await conferirModeloEscolhido(cliente, "org-1", "lembrete_consulta");
    expect(r.ok).toBe(false);
  });
});
