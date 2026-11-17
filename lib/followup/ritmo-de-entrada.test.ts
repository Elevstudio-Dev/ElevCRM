import { describe, expect, it } from "vitest";

import {
  JANELA_DO_LIMITE_MS,
  decidirEntrada,
  esperaDepoisDe,
  previsaoDeEntrada,
  ritmoDeEntradaSchema,
  type EstadoDoRitmo,
} from "./ritmo-de-entrada";

const RITMO = { min_minutos: 3, max_minutos: 9, limite_por_dia: 25 };
const AGORA = new Date("2026-11-18T15:00:00.000Z");
const MIN = 60_000;
const SEM_ESTADO: EstadoDoRitmo = { ultimaEm: null, ultimaId: null, nasUltimas24h: 0 };

describe("ritmoDeEntradaSchema", () => {
  it("aceita o ritmo da clínica (3 a 9 minutos, 25 por dia)", () => {
    expect(ritmoDeEntradaSchema.safeParse(RITMO).success).toBe(true);
  });
  it("recusa máximo menor que o mínimo e campo desconhecido", () => {
    expect(ritmoDeEntradaSchema.safeParse({ ...RITMO, max_minutos: 2 }).success).toBe(false);
    expect(ritmoDeEntradaSchema.safeParse({ ...RITMO, extra: 1 }).success).toBe(false);
    expect(ritmoDeEntradaSchema.safeParse({ ...RITMO, limite_por_dia: 0 }).success).toBe(false);
  });
});

describe("esperaDepoisDe", () => {
  it("é sempre um valor inteiro dentro da faixa, e igual para o mesmo id", () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const m = esperaDepoisDe(id, RITMO);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(3);
      expect(m).toBeLessThanOrEqual(9);
      expect(esperaDepoisDe(id, RITMO)).toBe(m);
      vistos.add(m);
    }
    // a faixa toda é usada, não só uma ponta
    expect(vistos.size).toBe(7);
  });
  it("faixa de um valor só devolve esse valor", () => {
    expect(esperaDepoisDe("qualquer", { ...RITMO, min_minutos: 5, max_minutos: 5 })).toBe(5);
  });
});

describe("decidirEntrada", () => {
  it("sem inscrição anterior, pode entrar", () => {
    expect(decidirEntrada(AGORA, RITMO, SEM_ESTADO, null)).toEqual({ pode: true });
  });

  it("antes do intervalo, espera e diz quando libera", () => {
    const id = "abc";
    const espera = esperaDepoisDe(id, RITMO);
    const ultimaEm = new Date(AGORA.getTime() - 1 * MIN);
    const d = decidirEntrada(AGORA, RITMO, { ultimaEm, ultimaId: id, nasUltimas24h: 1 }, ultimaEm);
    expect(d.pode).toBe(false);
    if (d.pode) return;
    expect(d.motivo).toBe("aguardando_intervalo");
    expect(d.liberaEm.getTime()).toBe(ultimaEm.getTime() + espera * MIN);
  });

  it("depois do intervalo, pode entrar", () => {
    const id = "abc";
    const ultimaEm = new Date(AGORA.getTime() - 10 * MIN);
    expect(
      decidirEntrada(AGORA, RITMO, { ultimaEm, ultimaId: id, nasUltimas24h: 1 }, ultimaEm).pode,
    ).toBe(true);
  });

  it("no limite das 24h, não entra mesmo com o intervalo vencido, e libera quando a mais antiga sai", () => {
    const maisAntiga = new Date(AGORA.getTime() - 20 * 60 * MIN);
    const ultimaEm = new Date(AGORA.getTime() - 30 * MIN);
    const d = decidirEntrada(
      AGORA,
      RITMO,
      { ultimaEm, ultimaId: "x", nasUltimas24h: 25 },
      maisAntiga,
    );
    expect(d.pode).toBe(false);
    if (d.pode) return;
    expect(d.motivo).toBe("limite_do_dia");
    expect(d.liberaEm.getTime()).toBe(maisAntiga.getTime() + JANELA_DO_LIMITE_MS);
  });
});

describe("previsaoDeEntrada", () => {
  it("espaça pela espera média e começa agora quando não há anterior", () => {
    const p = previsaoDeEntrada(AGORA, RITMO, SEM_ESTADO, [], 3);
    expect(p.map((d) => d.getTime())).toEqual([
      AGORA.getTime(),
      AGORA.getTime() + 6 * MIN,
      AGORA.getTime() + 12 * MIN,
    ]);
  });

  it("começa depois do intervalo da última inscrição", () => {
    const ultimaEm = new Date(AGORA.getTime() - 1 * MIN);
    const espera = esperaDepoisDe("u", RITMO);
    const [primeiro] = previsaoDeEntrada(
      AGORA,
      RITMO,
      { ultimaEm, ultimaId: "u", nasUltimas24h: 1 },
      [ultimaEm],
      1,
    );
    expect(primeiro!.getTime()).toBe(Math.max(AGORA.getTime(), ultimaEm.getTime() + espera * MIN));
  });

  it("com o limite cheio, o excedente vai para depois da reabertura da janela", () => {
    const ritmo = { min_minutos: 3, max_minutos: 3, limite_por_dia: 2 };
    const a = new Date(AGORA.getTime() - 10 * 60 * MIN);
    const b = new Date(AGORA.getTime() - 5 * 60 * MIN);
    const p = previsaoDeEntrada(
      AGORA,
      ritmo,
      { ultimaEm: b, ultimaId: "u", nasUltimas24h: 2 },
      [a, b],
      2,
    );
    // a primeira vaga reabre quando `a` completa 24h
    expect(p[0]!.getTime()).toBe(a.getTime() + JANELA_DO_LIMITE_MS);
    // a segunda: a janela agora tem [b, primeira] e o limite é 2, então espera `b` sair
    expect(p[1]!.getTime()).toBe(b.getTime() + JANELA_DO_LIMITE_MS);
  });

  it("nunca prevê mais que o limite dentro de 24h corridas", () => {
    const ritmo = { min_minutos: 3, max_minutos: 3, limite_por_dia: 5 };
    const p = previsaoDeEntrada(AGORA, ritmo, SEM_ESTADO, [], 40);
    for (let i = 0; i + 5 < p.length; i++) {
      expect(p[i + 5]!.getTime() - p[i]!.getTime()).toBeGreaterThanOrEqual(JANELA_DO_LIMITE_MS);
    }
  });
});
