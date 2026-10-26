import { describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";

import {
  ATRASO_MAXIMO_MS,
  decidirLembrete,
  momentoDevido,
  type EntradaDaDecisao,
} from "./decisao";

/**
 * A REGRA DO LEMBRETE, COM DATAS NA MÃO.
 *
 * Cenário-base: consulta na segunda 2026-10-26 às 14h de Brasília (17:00Z),
 * lembrete 24 h antes — devido no domingo 25/10 às 14h local. Nada aqui lê banco
 * nem canal; cada caso muda UMA coisa e afirma o desfecho.
 */

const COMECA = new Date("2026-10-26T17:00:00Z"); // 14:00 em America/Sao_Paulo (UTC-3)
const DEVIDO = new Date("2026-10-25T17:00:00Z"); // 24 h antes
const ARMADO_HA_MUITO = new Date("2026-10-20T12:00:00Z");

const base: EntradaDaDecisao = {
  agora: new Date(DEVIDO.getTime() + 5 * 60_000),
  comecaEm: COMECA,
  minutosAntes: 1440,
  armadoEm: ARMADO_HA_MUITO,
  contatoSemMensagens: false,
  fuso: "America/Sao_Paulo",
};

const com = (parcial: Partial<EntradaDaDecisao>): EntradaDaDecisao => ({ ...base, ...parcial });
const apos = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe("a premissa de horário de cortesia que estes testes assumem", () => {
  it("é 7h–22h — se o padrão mudar, os casos de borda abaixo precisam ser relidos", () => {
    expect(PACING_DEFAULTS.windowStartHour).toBe(7);
    expect(PACING_DEFAULTS.windowEndHour).toBe(22);
  });
});

describe("momentoDevido", () => {
  it("é o início menos a antecedência pedida", () => {
    expect(momentoDevido(COMECA, 1440).toISOString()).toBe(DEVIDO.toISOString());
    expect(momentoDevido(COMECA, 120).toISOString()).toBe("2026-10-26T15:00:00.000Z");
  });
});

describe("enviar", () => {
  it("passou do momento devido, está dentro do prazo e da cortesia: envia (controle positivo)", () => {
    expect(decidirLembrete(base)).toEqual({ acao: "enviar" });
  });

  it("no instante exato do momento devido já envia", () => {
    expect(decidirLembrete(com({ agora: DEVIDO }))).toEqual({ acao: "enviar" });
  });
});

describe("esperar — vale mais tarde", () => {
  it("antes do momento devido: not_due", () => {
    expect(decidirLembrete(com({ agora: apos(DEVIDO, -60_000) }))).toEqual({
      acao: "esperar",
      motivo: "not_due",
    });
  });

  it("de madrugada no fuso do compromisso: espera a cortesia, não descarta", () => {
    // Consulta às 06:30 de segunda; devido domingo 06:30 local (09:30Z). Às 06:45
    // local ainda está fechado; às 07:00 abre.
    const comeca = new Date("2026-10-26T09:30:00Z"); // 06:30 local
    const devido = momentoDevido(comeca, 1440); // domingo 06:30 local
    expect(decidirLembrete(com({ comecaEm: comeca, agora: apos(devido, 15 * 60_000) }))).toEqual({
      acao: "esperar",
      motivo: "outside_courtesy_hours",
    });
    expect(decidirLembrete(com({ comecaEm: comeca, agora: apos(devido, 30 * 60_000) }))).toEqual({
      acao: "enviar",
    });
  });

  it("a cortesia é medida no FUSO do compromisso, não no do servidor", () => {
    // O momento devido cai às 10:30Z: 07:30 em Brasília (aberto) e 06:30 em Manaus
    // (UTC-4, ainda fechado). Mesmo instante, desfechos diferentes.
    const comeca = new Date("2026-10-27T10:30:00Z");
    const agora = new Date("2026-10-26T10:30:00Z");
    expect(decidirLembrete(com({ comecaEm: comeca, agora, fuso: "America/Sao_Paulo" }))).toEqual({
      acao: "enviar",
    });
    expect(decidirLembrete(com({ comecaEm: comeca, agora, fuso: "America/Manaus" }))).toEqual({
      acao: "esperar",
      motivo: "outside_courtesy_hours",
    });
  });

  it("fuso inválido cai no padrão do produto em vez de derrubar o tick inteiro", () => {
    expect(decidirLembrete(com({ fuso: "Marte/Olympus_Mons" }))).toEqual({ acao: "enviar" });
  });
});

describe("pular — terminal para este horário", () => {
  it("contato que pediu para não receber mensagens: blocked, antes de tudo", () => {
    expect(decidirLembrete(com({ contatoSemMensagens: true }))).toEqual({
      acao: "pular",
      motivo: "blocked",
    });
    // E vence até o "marcado dentro do prazo": o motivo a registrar é a vontade da pessoa.
    expect(
      decidirLembrete(com({ contatoSemMensagens: true, armadoEm: apos(DEVIDO, 1) })),
    ).toEqual({ acao: "pular", motivo: "blocked" });
  });

  it("armado no momento devido ou depois: booked_inside_horizon", () => {
    expect(decidirLembrete(com({ armadoEm: DEVIDO }))).toEqual({
      acao: "pular",
      motivo: "booked_inside_horizon",
    });
    expect(decidirLembrete(com({ armadoEm: apos(DEVIDO, 3_600_000) }))).toEqual({
      acao: "pular",
      motivo: "booked_inside_horizon",
    });
  });

  it("armado um instante ANTES do momento devido ainda é lembrado (a borda é exclusiva)", () => {
    expect(decidirLembrete(com({ armadoEm: apos(DEVIDO, -1) }))).toEqual({ acao: "enviar" });
  });

  it("mais de seis horas depois do momento devido: late", () => {
    const tarde = apos(DEVIDO, ATRASO_MAXIMO_MS + 60_000);
    expect(decidirLembrete(com({ agora: tarde }))).toEqual({ acao: "pular", motivo: "late" });
    // E exatamente no limite ainda vale.
    expect(decidirLembrete(com({ agora: apos(DEVIDO, ATRASO_MAXIMO_MS) }))).toEqual({
      acao: "enviar",
    });
  });

  it("faltando menos de uma hora para a consulta: late", () => {
    // Lembrete de 2 h: devido 12:00 local; às 13:30 faltam 30 min.
    const r = decidirLembrete(
      com({ minutosAntes: 120, agora: new Date("2026-10-26T16:30:00Z") }),
    );
    expect(r).toEqual({ acao: "pular", motivo: "late" });
    // Às 12:30 faltam 90 min — ainda serve.
    expect(
      decidirLembrete(com({ minutosAntes: 120, agora: new Date("2026-10-26T15:30:00Z") })),
    ).toEqual({ acao: "enviar" });
  });

  it("consulta que já começou: late", () => {
    expect(decidirLembrete(com({ agora: apos(COMECA, 60_000) }))).toEqual({
      acao: "pular",
      motivo: "late",
    });
  });

  it("lembrete curto (30 min) não é engolido pela folga de uma hora", () => {
    // devido = 13:30 local; a folga mínima cai para 15 min, então 1 min depois do
    // devido (29 min antes) ainda envia.
    const agora = new Date("2026-10-26T16:31:00Z");
    expect(decidirLembrete(com({ minutosAntes: 30, agora }))).toEqual({ acao: "enviar" });
  });
});
