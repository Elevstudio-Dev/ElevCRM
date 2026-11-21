import { describe, expect, it } from "vitest";

import type { RelatoLido } from "@/lib/agenda/secretaria/relato";
import {
  conflitosComFechamento,
  mesmoPaciente,
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
    expect(p.substituirIds).toEqual([]);
    expect(p.conflitos).toEqual([]);
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

  it("duas pessoas no MESMO horário: o banco só aceita UM compromisso por horário do mesmo dono — cria um e devolve o outro como conflito (nada some calado)", () => {
    // Antes o plano mandava criar os dois e o índice `calendar_appointments_sem_duplicata_idx` derrubava o lote
    // inteiro. A hora fica tomada de qualquer jeito; quem não coube volta para a secretaria saber.
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
          { nome: "João", inicio: "2026-11-18T14:00:00-03:00" },
        ],
      }),
    });
    expect(p.criar).toHaveLength(1);
    expect(p.conflitos).toHaveLength(1);
    expect(p.conflitos[0]).toMatchObject({ porque: "horario_ja_ocupado" });
    expect([p.criar[0]!.nome, p.conflitos[0]!.nome].sort()).toEqual(["João", "Maria"]);
  });
});

describe("planejarSincronizacao — o MESMO horário (a falha de produção)", () => {
  it("o relato novo troca o paciente de um horário: o antigo entra em `substituirIds` (cancelado ANTES do insert)", () => {
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "Beltrano", inicio: "2026-11-18T08:30:00-03:00" },
          { nome: "Ana", inicio: "2026-11-18T10:00:00-03:00" },
        ],
      }),
      existentes: [
        existente("fulano", "Fulano", "2026-11-18T11:30:00Z"), // 08h30: trocado
        existente("sumiu", "Zé", "2026-11-18T15:00:00Z"), // 12h: sumiu
      ],
    });
    expect(p.criar.map((c) => c.nome)).toEqual(["Beltrano", "Ana"]);
    expect(p.cancelarIds.sort()).toEqual(["fulano", "sumiu"]);
    // Só o que ocupa o horário de um compromisso a criar é cancelado antes; o resto segue "criar antes de cancelar".
    expect(p.substituirIds).toEqual(["fulano"]);
    expect(p.conflitos).toEqual([]);
  });

  it("horário ocupado por compromisso que NÃO é de relato (IA de vendas, marcação à mão): não cria o espelho, devolve o conflito e não cancela nada dele", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Beltrano", inicio: "2026-11-18T16:00:00-03:00" }] }),
      ocupadosForaDoRelato: [{ inicio: new Date("2026-11-18T19:00:00Z"), nomes: ["Avaliação - Sicrano", "Sicrano Souza"] }],
    });
    expect(p.criar).toEqual([]);
    expect(p.jaNaAgenda).toEqual([]);
    expect(p.cancelarIds).toEqual([]);
    expect(p.substituirIds).toEqual([]);
    expect(p.conflitos).toEqual([
      { inicio: new Date("2026-11-18T19:00:00Z"), nome: "Beltrano", porque: "outro_compromisso" },
    ]);
  });

  describe("o ocupante que não é de relato é o MESMO paciente (ex.: a IA de vendas marcou) — I2", () => {
    const BELTRANO = { nome: "Beltrano", inicio: "2026-11-18T16:00:00-03:00" };
    const as16h = new Date("2026-11-18T19:00:00Z");

    it("título do compromisso contém o nome do relato: 'já está na agenda' — sem espelho e SEM conflito", () => {
      const p = plano({
        relato: relato({ marcados: [BELTRANO] }),
        ocupadosForaDoRelato: [{ inicio: as16h, nomes: ["Avaliação - Beltrano Silva", ""] }],
      });
      expect(p.criar).toEqual([]);
      expect(p.conflitos).toEqual([]);
      expect(p.jaNaAgenda.map((c) => c.nome)).toEqual(["Beltrano"]);
    });

    it("o nome do CONTATO casa mesmo com título genérico", () => {
      const p = plano({
        relato: relato({ marcados: [BELTRANO] }),
        ocupadosForaDoRelato: [{ inicio: as16h, nomes: ["Avaliação", "Beltrano"] }],
      });
      expect(p.conflitos).toEqual([]);
      expect(p.jaNaAgenda).toHaveLength(1);
    });

    it("acento e caixa não importam ('JOÃO' no relato, 'joao pedro' no contato)", () => {
      const p = plano({
        relato: relato({ marcados: [{ nome: "JOÃO", inicio: "2026-11-18T16:00:00-03:00" }] }),
        ocupadosForaDoRelato: [{ inicio: as16h, nomes: ["Consulta", "joao pedro"] }],
      });
      expect(p.conflitos).toEqual([]);
      expect(p.jaNaAgenda).toHaveLength(1);
    });

    it("ocupante sem título nem contato: é OUTRA pessoa até prova em contrário — conflito avisado", () => {
      const p = plano({
        relato: relato({ marcados: [BELTRANO] }),
        ocupadosForaDoRelato: [{ inicio: as16h, nomes: ["", ""] }],
      });
      expect(p.jaNaAgenda).toEqual([]);
      expect(p.conflitos).toMatchObject([{ nome: "Beltrano", porque: "outro_compromisso" }]);
    });

    it.each([
      ["Lia", ["Avaliação"], false], // "lia" é pedaço de "avaliacao", não palavra
      ["Ana", ["Juliana Souza"], false], // "ana" dentro de "juliana" não é a Ana
      ["Ana", ["Avaliação - Ana Souza"], true],
      ["Ana Paula", ["Ana Paula Souza"], true],
      ["Ana Paula", ["Ana Souza"], false], // falta "paula": não é garantido que seja ela
      ["Paula Ana", ["Ana Paula Souza"], true], // a ordem das palavras não importa
    ])("palavras INTEIRAS: relato '%s' contra ocupante %j → mesmo paciente = %s", (nome, nomes, mesmo) => {
      expect(mesmoPaciente(nome, nomes)).toBe(mesmo);
    });

    it("outra pessoa no horário continua conflito avisado", () => {
      const p = plano({
        relato: relato({ marcados: [BELTRANO] }),
        ocupadosForaDoRelato: [{ inicio: as16h, nomes: ["Avaliação - Fulano", "Fulano"] }],
      });
      expect(p.conflitos).toHaveLength(1);
      expect(p.jaNaAgenda).toEqual([]);
    });
  });

  it("horário de um compromisso de relato que JÁ PASSOU (histórico, não é cancelado): o novo do mesmo horário é conflito, não erro", () => {
    const p = plano({
      relato: relato({ marcados: [{ nome: "Beltrano", inicio: "2026-11-18T08:00:00-03:00" }] }),
      existentes: [existente("passado", "Fulano", "2026-11-18T11:00:00Z")], // 08h–08h30, antes das 09h de AGORA
    });
    expect(p.cancelarIds).toEqual([]);
    expect(p.criar).toEqual([]);
    expect(p.conflitos).toMatchObject([{ nome: "Beltrano", porque: "horario_ja_ocupado" }]);
  });

  it("horário de um compromisso MANTIDO + outra pessoa no mesmo horário: mantém o que está, a outra vira conflito", () => {
    const p = plano({
      relato: relato({
        marcados: [
          { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
          { nome: "João", inicio: "2026-11-18T14:00:00-03:00" },
        ],
      }),
      existentes: [existente("maria", "Maria", "2026-11-18T17:00:00Z")],
    });
    expect(p.manterIds).toEqual(["maria"]);
    expect(p.criar).toEqual([]);
    expect(p.conflitos).toMatchObject([{ nome: "João", porque: "horario_ja_ocupado" }]);
  });

  it("reprocessar o plano depois de aplicado não gera conflito novo (idempotente com o conflito)", () => {
    const r = relato({
      marcados: [
        { nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" },
        { nome: "Beltrano", inicio: "2026-11-18T16:00:00-03:00" },
      ],
    });
    const ocupadosForaDoRelato = [{ inicio: new Date("2026-11-18T19:00:00Z"), nomes: ["Outra Pessoa"] }];
    const primeiro = plano({ relato: r, ocupadosForaDoRelato });
    const segundo = plano({
      relato: r,
      ocupadosForaDoRelato,
      existentes: primeiro.criar.map((c, i) => ({ id: `c${i}`, ...c })),
    });
    expect(segundo.criar).toEqual([]);
    expect(segundo.cancelarIds).toEqual([]);
    expect(segundo.conflitos).toEqual(primeiro.conflitos);
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
