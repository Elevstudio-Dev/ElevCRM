import { describe, expect, it } from "vitest";

import {
  RITMO_PADRAO,
  contarPorDia,
  instanteLocal,
  intervaloAntesDe,
  partesLocais,
  planejarHorarios,
  ritmoDaCampanhaSchema,
  type RitmoDaCampanha,
} from "./horarios";

const SP = "America/Sao_Paulo";

describe("planejarHorarios", () => {
  it("nunca agenda fora do horário nem em dia proibido, e respeita o teto do dia", () => {
    // quarta-feira 26/11/2026 às 20h em São Paulo: já passou do horário
    const agora = instanteLocal(2026, 11, 26, 20, 0, SP);
    const horarios = planejarHorarios(agora, 100, RITMO_PADRAO, SP, "campanha-x");
    expect(horarios).toHaveLength(100);

    const porDia = new Map<string, number>();
    for (const h of horarios) {
      const p = partesLocais(h, SP);
      expect(p.hora).toBeGreaterThanOrEqual(9);
      expect(p.hora).toBeLessThan(18);
      expect(p.diaDaSemana).not.toBe(0); // domingo
      const k = `${p.ano}-${p.mes}-${p.dia}`;
      porDia.set(k, (porDia.get(k) ?? 0) + 1);
    }
    for (const n of porDia.values()) expect(n).toBeLessThanOrEqual(30);

    // o primeiro sai às 9h do dia seguinte (quinta 27/11)
    const primeiro = partesLocais(horarios[0]!, SP);
    expect([primeiro.dia, primeiro.hora, primeiro.minuto]).toEqual([27, 9, 0]);
  });

  it("deixa entre um envio e o seguinte um intervalo dentro da faixa, no mesmo dia", () => {
    const agora = instanteLocal(2026, 11, 27, 9, 0, SP);
    const horarios = planejarHorarios(agora, 20, RITMO_PADRAO, SP, "semente");
    for (let i = 1; i < horarios.length; i++) {
      const a = partesLocais(horarios[i - 1]!, SP);
      const b = partesLocais(horarios[i]!, SP);
      if (a.dia !== b.dia) continue;
      const min = (horarios[i]!.getTime() - horarios[i - 1]!.getTime()) / 60_000;
      expect(min).toBeGreaterThanOrEqual(RITMO_PADRAO.min_minutos);
      expect(min).toBeLessThanOrEqual(RITMO_PADRAO.max_minutos);
    }
  });

  it("é determinístico: a mesma semente dá a mesma agenda", () => {
    const agora = instanteLocal(2026, 11, 27, 10, 0, SP);
    const a = planejarHorarios(agora, 50, RITMO_PADRAO, SP, "abc").map((d) => d.toISOString());
    const b = planejarHorarios(agora, 50, RITMO_PADRAO, SP, "abc").map((d) => d.toISOString());
    expect(a).toEqual(b);
  });

  it("pula sábado e domingo quando só dias úteis são permitidos", () => {
    const ritmo: RitmoDaCampanha = { ...RITMO_PADRAO, por_dia: 2, dias: [1, 2, 3, 4, 5] };
    // sexta 27/11/2026 às 17h59
    const agora = instanteLocal(2026, 11, 27, 17, 59, SP);
    const horarios = planejarHorarios(agora, 3, ritmo, SP, "s");
    const dias = horarios.map((h) => partesLocais(h, SP).diaDaSemana);
    expect(dias[0]).toBe(5); // sexta, 17h59
    expect(dias[1]).toBe(1); // segunda
    expect(dias[2]).toBe(1);
  });

  it("na retomada, conta o que já saiu hoje no teto do dia", () => {
    const ritmo: RitmoDaCampanha = { ...RITMO_PADRAO, por_dia: 3 };
    const agora = instanteLocal(2026, 11, 27, 10, 0, SP);
    const jaSaiu = contarPorDia([agora, agora], SP);
    const horarios = planejarHorarios(agora, 2, ritmo, SP, "s", jaSaiu);
    expect(partesLocais(horarios[0]!, SP).dia).toBe(27);
    expect(partesLocais(horarios[1]!, SP).dia).toBe(28);
  });

  it("intervaloAntesDe fica sempre na faixa", () => {
    for (let i = 0; i < 500; i++) {
      const m = intervaloAntesDe("x", i, RITMO_PADRAO);
      expect(m).toBeGreaterThanOrEqual(RITMO_PADRAO.min_minutos);
      expect(m).toBeLessThanOrEqual(RITMO_PADRAO.max_minutos);
    }
  });
});

describe("ritmoDaCampanhaSchema", () => {
  it("recusa horário invertido e intervalo invertido", () => {
    expect(ritmoDaCampanhaSchema.safeParse({ ...RITMO_PADRAO, hora_inicio: 18, hora_fim: 9 }).success).toBe(false);
    expect(ritmoDaCampanhaSchema.safeParse({ ...RITMO_PADRAO, min_minutos: 10, max_minutos: 5 }).success).toBe(false);
    expect(ritmoDaCampanhaSchema.safeParse(RITMO_PADRAO).success).toBe(true);
  });
});
