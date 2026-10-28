import { describe, expect, it } from "vitest";

import {
  agruparOrigens,
  conversao,
  grupoDaOrigem,
  ORDEM_DOS_GRUPOS,
  ROTULO_DO_GRUPO,
  serieDiaria,
  type LinhaDeOrigem,
} from "./origens";

const linha = (over: Partial<LinhaDeOrigem>): LinhaDeOrigem => ({
  source: "whatsapp",
  detalhe: null,
  leads: 0,
  abertos: 0,
  ganhos: 0,
  perdidos: 0,
  valor_ganho_cents: 0,
  ...over,
});

const SEM_NOMES = { qr: new Map<string, string>(), fonte: new Map<string, string>() };

describe("grupoDaOrigem", () => {
  it.each([
    ["qr_code", "qr"],
    ["meta_ads", "anuncio"],
    ["google_ads", "anuncio"],
    ["webhook", "formulario"],
    ["whatsapp", "whatsapp"],
    ["manual", "manual"],
    ["import", "importado"],
    ["importacao", "importado"],
    ["csv", "importado"],
    ["planilha", "importado"],
    ["agent", "ia"],
    ["ai_agent", "ia"],
    ["reactivation", "ia"],
    ["landing", "outros"],
    ["desconhecida", "outros"],
  ] as const)("%s → %s", (source, grupo) => {
    expect(grupoDaOrigem(source)).toBe(grupo);
  });

  it("todo grupo tem rótulo e está na ordem", () => {
    for (const g of ORDEM_DOS_GRUPOS) expect(ROTULO_DO_GRUPO[g]).toBeTruthy();
    expect(new Set(ORDEM_DOS_GRUPOS).size).toBe(8);
  });
});

describe("conversao", () => {
  it("ganhos ÷ (ganhos + perdidos)", () => {
    expect(conversao(3, 1)).toBe(0.75);
  });
  it("ninguém fechou ainda → null (não '0%')", () => {
    expect(conversao(0, 0)).toBeNull();
  });
});

describe("agruparOrigens", () => {
  it("dois QRs viram UM grupo com dois detalhes rotulados pelo nome, e o grupo soma os dois", () => {
    const nomes = { qr: new Map([["qr-1", "Cartaz"], ["qr-2", "Panfleto"]]), fonte: new Map<string, string>() };
    const { grupos } = agruparOrigens(
      [
        linha({ source: "qr_code", detalhe: "qr-1", leads: 5, abertos: 3, ganhos: 1, perdidos: 1, valor_ganho_cents: 10000 }),
        linha({ source: "qr_code", detalhe: "qr-2", leads: 2, abertos: 2 }),
      ],
      nomes,
    );
    expect(grupos).toHaveLength(1);
    const qr = grupos[0]!;
    expect(qr.grupo).toBe("qr");
    expect(qr.leads).toBe(7);
    expect(qr.abertos).toBe(5);
    expect(qr.detalhes.map((d) => d.rotulo)).toEqual(["Cartaz", "Panfleto"]); // por leads desc
    expect(qr.detalhes[0]).toMatchObject({ leads: 5, ganhos: 1, perdidos: 1, valorGanhoCents: 10000, conversao: 0.5 });
  });

  it("QR que não está mais no mapa vira 'QR removido'", () => {
    const { grupos } = agruparOrigens([linha({ source: "qr_code", detalhe: "qr-x", leads: 1 })], SEM_NOMES);
    expect(grupos[0]!.detalhes[0]!.rotulo).toBe("QR removido");
  });

  it("formulário: 'fonte:<id>' vira o nome da fonte; campanha fica como veio; sem nada vira 'Formulário sem campanha'", () => {
    const nomes = { qr: new Map<string, string>(), fonte: new Map([["src-1", "Landing Clareamento"]]) };
    const { grupos } = agruparOrigens(
      [
        linha({ source: "webhook", detalhe: "fonte:src-1", leads: 4 }),
        linha({ source: "webhook", detalhe: "black-friday", leads: 3 }),
        linha({ source: "webhook", detalhe: "fonte:src-apagada", leads: 2 }),
        linha({ source: "webhook", detalhe: null, leads: 1 }),
      ],
      nomes,
    );
    expect(grupos[0]!.detalhes.map((d) => [d.rotulo, d.leads])).toEqual([
      ["Landing Clareamento", 4],
      ["black-friday", 3],
      ["Formulário sem campanha", 3], // a fonte apagada e o sem-nada caem no mesmo rótulo e somam
    ]);
  });

  it("anúncio: o título do anúncio é o detalhe; sem título, 'Anúncio sem título'; Meta e Google com o mesmo título somam", () => {
    const { grupos } = agruparOrigens(
      [
        linha({ source: "meta_ads", detalhe: "Clareamento", leads: 2 }),
        linha({ source: "google_ads", detalhe: "Clareamento", leads: 1 }),
        linha({ source: "meta_ads", detalhe: null, leads: 1 }),
      ],
      SEM_NOMES,
    );
    expect(grupos[0]!.detalhes.map((d) => [d.rotulo, d.leads])).toEqual([
      ["Clareamento", 3],
      ["Anúncio sem título", 1],
    ]);
  });

  it("origens sem detalhe têm um detalhe só, com o rótulo do grupo", () => {
    const { grupos } = agruparOrigens(
      [linha({ source: "whatsapp", leads: 8 }), linha({ source: "landing", leads: 1 }), linha({ source: "xyz", leads: 1 })],
      SEM_NOMES,
    );
    const outros = grupos.find((g) => g.grupo === "outros")!;
    expect(outros.detalhes).toHaveLength(1);
    expect(outros.detalhes[0]!.rotulo).toBe("Outras origens");
    expect(outros.leads).toBe(2);
  });

  it("só aparecem grupos com leads, na ordem fixa", () => {
    const { grupos } = agruparOrigens(
      [linha({ source: "manual", leads: 1 }), linha({ source: "qr_code", detalhe: "q", leads: 1 }), linha({ source: "whatsapp", leads: 0 })],
      SEM_NOMES,
    );
    expect(grupos.map((g) => g.grupo)).toEqual(["qr", "manual"]);
  });

  it("o total geral soma tudo, e o valor ganho soma só os ganhos", () => {
    const { total } = agruparOrigens(
      [
        linha({ source: "whatsapp", leads: 10, abertos: 6, ganhos: 3, perdidos: 1, valor_ganho_cents: 150000 }),
        linha({ source: "manual", leads: 2, abertos: 1, ganhos: 1, perdidos: 0, valor_ganho_cents: 50000 }),
      ],
      SEM_NOMES,
    );
    expect(total).toEqual({
      leads: 12,
      abertos: 7,
      ganhos: 4,
      perdidos: 1,
      valorGanhoCents: 200000,
      conversao: 0.8,
    });
  });

  it("sem linhas: total zerado e conversão null", () => {
    const r = agruparOrigens([], SEM_NOMES);
    expect(r.grupos).toEqual([]);
    expect(r.total).toMatchObject({ leads: 0, conversao: null });
  });
});

describe("serieDiaria", () => {
  // Meia-noite de São Paulo (UTC-3, sem horário de verão desde 2019).
  const DE = new Date("2026-10-01T03:00:00Z");
  const ATE = new Date("2026-10-04T03:00:00Z");

  it("preenche os dias SEM lead com zero — o gráfico não pode pular dia", () => {
    const s = serieDiaria([{ dia: "2026-10-02", source: "qr_code", leads: 2 }], DE, ATE, "America/Sao_Paulo");
    expect(s.map((d) => d.dia)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(s[0]).toMatchObject({ qr: 0, whatsapp: 0, outros: 0 });
    expect(s[1]).toMatchObject({ qr: 2 });
    expect(s[2]).toMatchObject({ qr: 0 });
  });

  it("soma por grupo no mesmo dia (Meta e Google caem em 'anuncio')", () => {
    const s = serieDiaria(
      [
        { dia: "2026-10-02", source: "meta_ads", leads: 3 },
        { dia: "2026-10-02", source: "google_ads", leads: 1 },
        { dia: "2026-10-02", source: "whatsapp", leads: 5 },
      ],
      DE,
      ATE,
      "America/Sao_Paulo",
    );
    expect(s[1]).toMatchObject({ anuncio: 4, whatsapp: 5 });
  });

  it("linha de um dia fora da janela não some em silêncio", () => {
    const s = serieDiaria([{ dia: "2026-10-09", source: "manual", leads: 1 }], DE, ATE, "America/Sao_Paulo");
    expect(s.find((d) => d.dia === "2026-10-09")).toMatchObject({ manual: 1 });
  });
});
