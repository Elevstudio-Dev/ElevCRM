// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Reserva } from "@/lib/agenda/secretaria/reservas";
import { executarTickDasReservas, type PortasDoTickDeReservas } from "@/lib/bastidor/secretaria/reservas-tick";

/**
 * O TICK DAS RESERVAS (o cron de 5 em 5 minutos), com portas de mentira.
 *
 * O que se prova: vencida é FECHADA pelo cron antes de qualquer aviso (quem ganha o fechamento é quem fala); sem
 * conversa com a secretaria a equipe é chamada à mão; falha de uma reserva não derruba as outras; pergunta perdida é
 * reenfileirada; confirmada sem compromisso vira aviso.
 */
const AGORA = new Date("2026-11-18T15:30:00Z");
const CONVERSA = { contactId: "sec-1", conversationId: "conv-1", channelSessionId: "canal-1" };

const reserva = (id: string, extra: Partial<Reserva> = {}): Reserva => ({
  id,
  organizationId: "org-1",
  contactId: `pac-${id}`,
  eventTypeId: "tipo-1",
  ownerUserId: "dono-1",
  inicio: new Date("2026-11-19T17:00:00Z"),
  fim: new Date("2026-11-19T17:30:00Z"),
  nomePaciente: `Paciente ${id}`,
  notas: null,
  status: "aguardando_secretaria",
  expiraEm: new Date("2026-11-18T15:15:00Z"),
  perguntadaEm: null,
  respondidaEm: null,
  appointmentId: null,
  pacienteAvisadoEm: null,
  ...extra,
});

interface Mundo {
  vencidas?: Reserva[];
  semPergunta?: Reserva[];
  confirmadas?: Reserva[];
  perdeFechamento?: string[];
  semConversa?: boolean;
  enfileirarFalha?: boolean;
  fechamentoQuebra?: string[];
}

function mundo(m: Mundo = {}) {
  const fila: string[] = [];
  const equipe: string[] = [];
  const erros: string[] = [];
  const p: PortasDoTickDeReservas = {
    agora: () => AGORA,
    registrarErro: (contexto) => void erros.push(contexto),
    vencidas: async () => m.vencidas ?? [],
    semPergunta: async () => m.semPergunta ?? [],
    confirmadasSemCompromisso: async () => m.confirmadas ?? [],
    expirar: async (r) => {
      if (m.fechamentoQuebra?.includes(r.id)) throw new Error("banco caiu");
      return !(m.perdeFechamento ?? []).includes(r.id);
    },
    conversaDaSecretaria: async () => (m.semConversa ? null : CONVERSA),
    enfileirar: async (_org, _conversa, acao, id) => {
      if (m.enfileirarFalha) throw new Error("fila fora do ar");
      fila.push(`${acao}:${id}`);
    },
    chamarEquipe: async (_org, _pac, aviso) => void equipe.push(aviso.titulo),
  };
  return { p, fila, equipe, erros };
}

describe("executarTickDasReservas", () => {
  it("vencida: o cron FECHA a reserva e enfileira o aviso ao paciente", async () => {
    const w = mundo({ vencidas: [reserva("a")] });
    const r = await executarTickDasReservas(w.p);
    expect(r).toEqual({ expiradas: 1, perguntasPedidas: 0, semCompromisso: 0 });
    expect(w.fila).toEqual(["avisar_paciente_reserva:a"]);
    expect(w.equipe).toEqual([]);
  });

  it("quem perde o fechamento (a secretaria respondeu no mesmo minuto) não avisa ninguém", async () => {
    const w = mundo({ vencidas: [reserva("a")], perdeFechamento: ["a"] });
    const r = await executarTickDasReservas(w.p);
    expect(r.expiradas).toBe(0);
    expect(w.fila).toEqual([]);
  });

  it("sem conversa com a secretaria, o worker não tem por onde avisar: a equipe avisa o paciente à mão", async () => {
    const w = mundo({ vencidas: [reserva("a")], semConversa: true });
    await executarTickDasReservas(w.p);
    expect(w.fila).toEqual([]);
    expect(w.equipe).toEqual(["Avise Paciente a: o pedido de horário venceu"]);
  });

  it("fila fora do ar DEPOIS de fechar: a equipe é chamada (o cron não tentará de novo) e o erro é registrado", async () => {
    const w = mundo({ vencidas: [reserva("a")], enfileirarFalha: true });
    await executarTickDasReservas(w.p);
    expect(w.equipe).toHaveLength(1);
    expect(w.erros).toEqual(["reservas: enfileirar o aviso de vencimento"]);
  });

  it("uma reserva que quebra não derruba as outras", async () => {
    const w = mundo({ vencidas: [reserva("a"), reserva("b")], fechamentoQuebra: ["a"] });
    const r = await executarTickDasReservas(w.p);
    expect(r.expiradas).toBe(1);
    expect(w.fila).toEqual(["avisar_paciente_reserva:b"]);
    expect(w.erros).toEqual(["reservas: vencimento"]);
  });

  it("pergunta perdida é reenfileirada (o worker serializa e carimba)", async () => {
    const w = mundo({ semPergunta: [reserva("a"), reserva("b")] });
    const r = await executarTickDasReservas(w.p);
    expect(r.perguntasPedidas).toBe(2);
    expect(w.fila).toEqual(["perguntar_reserva:a", "perguntar_reserva:b"]);
  });

  it("pergunta perdida sem conversa não enfileira nada (a reserva vencerá e a equipe será chamada)", async () => {
    const w = mundo({ semPergunta: [reserva("a")], semConversa: true });
    const r = await executarTickDasReservas(w.p);
    expect(r.perguntasPedidas).toBe(0);
    expect(w.fila).toEqual([]);
  });

  it("confirmada que não virou compromisso: aviso à equipe para fechar à mão", async () => {
    const w = mundo({ confirmadas: [reserva("a", { status: "confirmada" })] });
    const r = await executarTickDasReservas(w.p);
    expect(r.semCompromisso).toBe(1);
    expect(w.equipe).toEqual(["Confirme à mão o horário de Paciente a"]);
  });

  it("tick sem nada a fazer devolve zeros", async () => {
    const w = mundo();
    expect(await executarTickDasReservas(w.p)).toEqual({ expiradas: 0, perguntasPedidas: 0, semCompromisso: 0 });
  });
});
