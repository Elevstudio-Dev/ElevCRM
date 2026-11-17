import { describe, expect, it } from "vitest";

import {
  diasDaJanela,
  diasEntre,
  limitesDaJanela,
  normalizarNome,
  problemasDoRelato,
  relatoLidoSchema,
  resumoParaConferencia,
  rotuloDaHora,
  rotuloDoDia,
  type RelatoLido,
} from "@/lib/agenda/secretaria/relato";

/**
 * O RELATO DA SECRETARIA — a parte pura: formato, coerência e o resumo que ela confere.
 *
 * O fuso dos exemplos é America/Sao_Paulo (UTC-3, sem horário de verão desde 2019): 14h locais = 17:00Z.
 */
const FUSO = "America/Sao_Paulo";

const relato = (over: Partial<RelatoLido> = {}): RelatoLido => ({
  janela: { de: "2026-11-18", ate: "2026-11-20" },
  marcados: [
    { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
    { nome: "João", inicio: "2026-11-18T15:30:00-03:00" },
  ],
  dias_fechados: [{ data: "2026-11-19", motivo: "feriado" }],
  duvidas: [],
  ...over,
});

describe("relatoLidoSchema", () => {
  it("aceita um relato coerente e põe `duvidas` vazio por padrão", () => {
    const { duvidas: _omitido, ...semDuvidas } = relato();
    const r = relatoLidoSchema.safeParse(semDuvidas);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.duvidas).toEqual([]);
  });

  it("recusa janela invertida, janela de mais de 31 dias e dia fechado fora da janela", () => {
    expect(relatoLidoSchema.safeParse(relato({ janela: { de: "2026-11-20", ate: "2026-11-18" } })).success).toBe(false);
    expect(relatoLidoSchema.safeParse(relato({ janela: { de: "2026-11-01", ate: "2026-12-15" } })).success).toBe(false);
    expect(
      relatoLidoSchema.safeParse(relato({ dias_fechados: [{ data: "2026-11-25" }] })).success,
    ).toBe(false);
  });

  it("a janela de 31 dias exatos é aceita", () => {
    const ok = relatoLidoSchema.safeParse(
      relato({ janela: { de: "2026-11-01", ate: "2026-12-01" }, marcados: [], dias_fechados: [] }),
    );
    expect(ok.success).toBe(true);
  });

  it("recusa instante sem fuso, data fora do formato e nome vazio", () => {
    expect(
      relatoLidoSchema.safeParse(relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00" }] })).success,
    ).toBe(false);
    expect(relatoLidoSchema.safeParse(relato({ janela: { de: "18/11/2026", ate: "20/11/2026" } })).success).toBe(false);
    expect(
      relatoLidoSchema.safeParse(relato({ marcados: [{ nome: "   ", inicio: "2026-11-18T14:00:00-03:00" }] })).success,
    ).toBe(false);
  });

  it("apara o nome", () => {
    const r = relatoLidoSchema.parse(relato({ marcados: [{ nome: "  Maria  ", inicio: "2026-11-18T14:00:00-03:00" }] }));
    expect(r.marcados[0]?.nome).toBe("Maria");
  });
});

describe("datas da janela", () => {
  it("diasEntre e diasDaJanela contam inclusive, atravessando o fim do mês", () => {
    expect(diasEntre("2026-11-28", "2026-12-02")).toBe(4);
    expect(diasDaJanela("2026-11-28", "2026-12-02")).toEqual([
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
    expect(diasDaJanela("2026-11-18", "2026-11-18")).toEqual(["2026-11-18"]);
  });

  it("limitesDaJanela: do começo do primeiro dia local ao começo do dia seguinte ao último", () => {
    const { inicio, fim } = limitesDaJanela({ de: "2026-11-18", ate: "2026-11-19" }, FUSO);
    expect(inicio.toISOString()).toBe("2026-11-18T03:00:00.000Z");
    expect(fim.toISOString()).toBe("2026-11-20T03:00:00.000Z");
  });
});

describe("normalizarNome", () => {
  it("ignora acento, caixa e espaços repetidos", () => {
    expect(normalizarNome("  JOÃO  da  Silva ")).toBe("joao da silva");
    expect(normalizarNome("Maria")).toBe(normalizarNome("maria"));
    expect(normalizarNome("Zé")).not.toBe(normalizarNome("Ze2"));
  });
});

describe("problemasDoRelato", () => {
  it("relato coerente: nenhum problema", () => {
    expect(problemasDoRelato(relato(), FUSO)).toEqual([]);
  });

  it("horário fora da janela informada vira pergunta, com o dia no texto", () => {
    const p = problemasDoRelato(
      relato({ marcados: [{ nome: "Ana", inicio: "2026-11-25T10:00:00-03:00" }] }),
      FUSO,
    );
    expect(p).toHaveLength(1);
    expect(p[0]?.mensagem).toMatch(/Ana/);
    expect(p[0]?.mensagem).toMatch(/25\/11/);
  });

  it("fim antes do começo é problema", () => {
    const p = problemasDoRelato(
      relato({
        marcados: [{ nome: "Ana", inicio: "2026-11-18T10:00:00-03:00", fim: "2026-11-18T09:00:00-03:00" }],
      }),
      FUSO,
    );
    expect(p.some((x) => /termina antes/.test(x.mensagem))).toBe(true);
  });

  it("o dia é lido NO FUSO da agenda: 23h30 de terça em Brasília é terça, mesmo sendo quarta em UTC", () => {
    const p = problemasDoRelato(
      relato({
        janela: { de: "2026-11-18", ate: "2026-11-18" },
        marcados: [{ nome: "Ana", inicio: "2026-11-18T23:30:00-03:00" }],
        dias_fechados: [],
      }),
      FUSO,
    );
    expect(p).toEqual([]);
  });
});

describe("rótulos", () => {
  it("rotuloDoDia: dia da semana e dia/mês", () => {
    expect(rotuloDoDia("2026-11-18")).toBe("qua 18/11");
    expect(rotuloDoDia("2026-11-22")).toBe("dom 22/11");
  });

  it("rotuloDaHora: 14h e 14h30, no fuso da agenda", () => {
    expect(rotuloDaHora(new Date("2026-11-18T17:00:00Z"), FUSO)).toBe("14h");
    expect(rotuloDaHora(new Date("2026-11-18T17:30:00Z"), FUSO)).toBe("14h30");
    expect(rotuloDaHora(new Date("2026-11-18T11:05:00Z"), FUSO)).toBe("8h05");
  });
});

describe("resumoParaConferencia", () => {
  it("uma linha por dia da janela, em ordem, com o fechado e o vazio explícitos", () => {
    const texto = resumoParaConferencia(relato(), FUSO);
    expect(texto.split("\n")).toEqual([
      "Entendi assim:",
      "qua 18/11: 14h Maria · 15h30 João",
      "qui 19/11: fechado (feriado)",
      "sex 20/11: ninguém marcado",
      "Está certo? Responda *sim* ou me diga o que corrigir.",
    ]);
  });

  it("ordena por horário mesmo com os marcados fora de ordem", () => {
    const texto = resumoParaConferencia(
      relato({
        janela: { de: "2026-11-18", ate: "2026-11-18" },
        marcados: [
          { nome: "Tarde", inicio: "2026-11-18T16:00:00-03:00" },
          { nome: "Manhã", inicio: "2026-11-18T09:00:00-03:00" },
        ],
        dias_fechados: [],
      }),
      FUSO,
    );
    expect(texto).toContain("qua 18/11: 9h Manhã · 16h Tarde");
  });

  it("dia fechado sem motivo não deixa parênteses vazios", () => {
    const texto = resumoParaConferencia(relato({ dias_fechados: [{ data: "2026-11-19" }] }), FUSO);
    expect(texto).toContain("qui 19/11: fechado\n");
  });

  it("termina sempre pedindo a conferência", () => {
    expect(resumoParaConferencia(relato(), FUSO).endsWith("me diga o que corrigir.")).toBe(true);
  });
});
