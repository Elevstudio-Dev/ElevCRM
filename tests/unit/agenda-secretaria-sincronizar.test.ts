import { describe, expect, it } from "vitest";

import type { RelatoLido } from "@/lib/agenda/secretaria/relato";
import {
  conflitosComFechamento,
  motivoDoFechamento,
  planejarSincronizacao,
  PREFIXO_DO_MOTIVO,
  type CompromissoDoRelato,
  type FechamentoDoRelato,
} from "@/lib/agenda/secretaria/sincronizar";

/**
 * COMO UM RELATO NOVO MUDA A AGENDA. O relato conta o dia INTEIRO a cada vez, então substitui o anterior — mas só
 * dentro da janela dele e só no que um relato criou. O que já passou é histórico e nunca é cancelado.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T12:00:00Z"); // 09h em Brasília

const relato = (over: Partial<RelatoLido> = {}): RelatoLido => ({
  janela: { de: "2026-11-18", ate: "2026-11-20" },
  marcados: [],
  dias_fechados: [],
  duvidas: [],
  ...over,
});

const existente = (id: string, nome: string, inicioIso: string, minutos = 30): CompromissoDoRelato => {
  const inicio = new Date(inicioIso);
  return { id, nome, inicio, fim: new Date(inicio.getTime() + minutos * 60_000) };
};

const plano = (over: Partial<Parameters<typeof planejarSincronizacao>[0]> = {}) =>
  planejarSincronizacao({
    existentes: [],
    fechamentosExistentes: [],
    relato: relato(),
    fuso: FUSO,
    duracaoMin: 30,
    agora: AGORA,
    ...over,
  });

describe("planejarSincronizacao — compromissos", () => {
  it("agenda vazia + relato com 2 marcados: cria os dois, em ordem de horário, com a duração do atendimento", () => {
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "João", inicio: "2026-11-18T15:00:00-03:00" },
          { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
        ],
      }),
    });
    expect(p.criar.map((c) => c.nome)).toEqual(["Maria", "João"]);
    expect(p.criar[0]!.fim.getTime() - p.criar[0]!.inicio.getTime()).toBe(30 * 60_000);
    expect(p.cancelarIds).toEqual([]);
    expect(p.manterIds).toEqual([]);
  });

  it("usa o fim que a secretaria deu, quando deu", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00", fim: "2026-11-18T15:00:00-03:00" }] }),
    });
    expect(p.criar[0]?.fim.toISOString()).toBe("2026-11-18T18:00:00.000Z");
  });

  it("o mesmo relato duas vezes não muda nada na segunda (idempotente)", () => {
    const r = relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" }] });
    const p = plano({ relato: r, existentes: [existente("a1", "Maria", "2026-11-18T17:00:00Z")] });
    expect(p.criar).toEqual([]);
    expect(p.cancelarIds).toEqual([]);
    expect(p.manterIds).toEqual(["a1"]);
  });

  it("nome comparado sem acento nem caixa: 'MARIA' e 'Maria' são o mesmo compromisso", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "João", inicio: "2026-11-18T14:00:00-03:00" }] }),
      existentes: [existente("a1", "JOAO", "2026-11-18T17:00:00Z")],
    });
    expect(p.manterIds).toEqual(["a1"]);
    expect(p.criar).toEqual([]);
  });

  it("a secretaria desmarcou: o que sumiu do relato (e ainda não aconteceu) é cancelado", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" }] }),
      existentes: [
        existente("a1", "Maria", "2026-11-18T17:00:00Z"),
        existente("a2", "João", "2026-11-18T18:00:00Z"),
      ],
    });
    expect(p.manterIds).toEqual(["a1"]);
    expect(p.cancelarIds).toEqual(["a2"]);
  });

  it("mudou o horário: cancela o antigo e cria o novo", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T16:00:00-03:00" }] }),
      existentes: [existente("a1", "Maria", "2026-11-18T17:00:00Z")],
    });
    expect(p.cancelarIds).toEqual(["a1"]);
    expect(p.criar).toHaveLength(1);
    expect(p.criar[0]?.inicio.toISOString()).toBe("2026-11-18T19:00:00.000Z");
  });

  it("o que JÁ ACONTECEU nunca é cancelado, mesmo sumindo do relato (é histórico)", () => {
    const p = plano({
      relato: relato({ marcados: [] }),
      existentes: [existente("passado", "Ana", "2026-11-18T11:00:00Z")], // 08h30, termina antes das 09h
    });
    expect(p.cancelarIds).toEqual([]);
  });

  it("o que está em andamento (já começou, ainda não terminou) ainda pode ser cancelado", () => {
    const p = plano({
      relato: relato({ marcados: [] }),
      existentes: [existente("andamento", "Ana", "2026-11-18T11:50:00Z")], // 08h50, termina 09h20
    });
    expect(p.cancelarIds).toEqual(["andamento"]);
  });

  it("duplicata de um relato antigo: mantém um e cancela o excedente", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" }] }),
      existentes: [
        existente("a1", "Maria", "2026-11-18T17:00:00Z"),
        existente("a2", "Maria", "2026-11-18T17:00:00Z"),
      ],
    });
    expect(p.manterIds).toEqual(["a1"]);
    expect(p.cancelarIds).toEqual(["a2"]);
  });

  it("a mesma pessoa citada duas vezes no mesmo horário vira um compromisso só", () => {
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
          { nome: "maria", inicio: "2026-11-18T14:00:00-03:00" },
        ],
      }),
    });
    expect(p.criar).toHaveLength(1);
  });

  it("duas pessoas no MESMO horário são dois compromissos (a agenda da franquia pode ter dois atendentes)", () => {
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
          { nome: "João", inicio: "2026-11-18T14:00:00-03:00" },
        ],
      }),
    });
    expect(p.criar).toHaveLength(2);
  });
});

describe("planejarSincronizacao — dias fechados", () => {
  const fechamento = (id: string, data: string): FechamentoDoRelato => ({ id, data });

  it("dia fechado novo: fecha, levando o motivo", () => {
    const p = plano({ relato: relato({ dias_fechados: [{ data: "2026-11-19", motivo: "feriado" }] }) });
    expect(p.fecharDias).toEqual([{ data: "2026-11-19", motivo: "feriado" }]);
    expect(p.reabrirIds).toEqual([]);
  });

  it("dia já fechado por um relato anterior: não fecha de novo", () => {
    const p = plano({
      relato: relato({ dias_fechados: [{ data: "2026-11-19" }] }),
      fechamentosExistentes: [fechamento("f1", "2026-11-19")],
    });
    expect(p.fecharDias).toEqual([]);
    expect(p.reabrirIds).toEqual([]);
  });

  it("o relato novo não fecha mais o dia: o fechamento que um relato criou é desfeito", () => {
    const p = plano({
      relato: relato({ dias_fechados: [] }),
      fechamentosExistentes: [fechamento("f1", "2026-11-19")],
    });
    expect(p.reabrirIds).toEqual(["f1"]);
  });
});

describe("motivoDoFechamento e conflitos", () => {
  it("o motivo leva o prefixo que diz 'veio de um relato' (é por ele que o fechamento é reconhecido depois)", () => {
    expect(motivoDoFechamento("feriado")).toBe(`${PREFIXO_DO_MOTIVO}feriado`);
    expect(motivoDoFechamento(null)).toBe(`${PREFIXO_DO_MOTIVO}fechado`);
    expect(motivoDoFechamento("x".repeat(500)).length).toBe(200);
  });

  it("marcado num dia que o mesmo relato fecha é contradição, e quem é aparece pelo nome", () => {
    const r = relato({
      marcados: [{ nome: "Maria", inicio: "2026-11-19T14:00:00-03:00" }],
      dias_fechados: [{ data: "2026-11-19" }],
    });
    expect(conflitosComFechamento(r, FUSO)).toEqual(["Maria"]);
    expect(conflitosComFechamento(relato(), FUSO)).toEqual([]);
  });
});
