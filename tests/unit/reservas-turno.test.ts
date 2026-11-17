// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Reserva } from "@/lib/agenda/secretaria/reservas";
import {
  responderAoPedidoDeReserva,
  vencerReserva,
  type PortasDaReserva,
} from "@/lib/bastidor/secretaria/reservas-turno";

/**
 * A CONVERSA DA RESERVA, com portas de mentira. O que se prova:
 *
 *  - o compromisso só nasce no "sim" de reserva ainda dentro da validade, e só uma vez;
 *  - o "não", o horário tomado no CRM e o vencimento mandam horários parecidos ao paciente (texto fixo) e, sem
 *    nenhum, chamam a equipe;
 *  - "sim" depois da validade não marca nada.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T15:00:00Z");

const RESERVA: Reserva = {
  id: "res-1",
  organizationId: "org-1",
  contactId: "pac-1",
  eventTypeId: "tipo-1",
  ownerUserId: "dono-1",
  inicio: new Date("2026-11-19T17:00:00Z"), // quinta 14h
  fim: new Date("2026-11-19T17:30:00Z"),
  nomePaciente: "Maria da Silva",
  notas: null,
  status: "aguardando_secretaria",
  expiraEm: new Date("2026-11-18T15:10:00Z"),
  perguntadaEm: new Date("2026-11-18T14:58:00Z"),
  respondidaEm: null,
  appointmentId: null,
  pacienteAvisadoEm: null,
};

const ALTERNATIVAS = [
  { inicio: new Date("2026-11-19T17:30:00Z"), fim: new Date("2026-11-19T18:00:00Z") },
  { inicio: new Date("2026-11-20T17:00:00Z"), fim: new Date("2026-11-20T17:30:00Z") },
];

interface Mundo {
  fechaGanha?: boolean;
  marcacao?: { ok: true; appointmentId: string } | { ok: false };
  alternativas?: typeof ALTERNATIVAS;
  reserva?: Partial<Reserva>;
}

function portas(mundo: Mundo = {}) {
  const eventos: string[] = [];
  const paciente: string[] = [];
  const secretaria: string[] = [];
  const equipe: string[] = [];
  const p: PortasDaReserva = {
    agora: AGORA,
    fuso: FUSO,
    reserva: { ...RESERVA, ...mundo.reserva },
    fechar: async (status) => {
      eventos.push(`fechar:${status}`);
      return mundo.fechaGanha ?? true;
    },
    marcar: async () => {
      eventos.push("marcar");
      return mundo.marcacao ?? { ok: true, appointmentId: "appt-1" };
    },
    ligarAoCompromisso: async (id) => void eventos.push(`ligar:${id}`),
    reverter: async () => void eventos.push("reverter"),
    horariosParecidos: async () => mundo.alternativas ?? ALTERNATIVAS,
    avisarPaciente: async (t) => void paciente.push(t),
    avisarSecretaria: async (t) => void secretaria.push(t),
    avisarEquipe: async (a) => void equipe.push(a.titulo),
  };
  return { p, eventos, paciente, secretaria, equipe };
}

describe("responderAoPedidoDeReserva — 'sim'", () => {
  it("fecha como confirmada, MARCA o compromisso, liga a reserva a ele e avisa paciente e secretaria", async () => {
    const m = portas();
    const r = await responderAoPedidoDeReserva(m.p, "sim");
    expect(r).toEqual({ acao: "confirmada", appointmentId: "appt-1" });
    expect(m.eventos).toEqual(["fechar:confirmada", "marcar", "ligar:appt-1"]);
    expect(m.paciente).toHaveLength(1);
    expect(m.paciente[0]).toMatch(/Tudo certo, Maria!.*confirmado.*quinta/);
    expect(m.secretaria[0]).toMatch(/Anotado!.*Maria da Silva.*Já avisei o paciente/);
    expect(m.equipe).toEqual([]);
  });

  it("reivindica ANTES de marcar: quem perde a corrida não marca nada nem avisa ninguém", async () => {
    const m = portas({ fechaGanha: false });
    expect(await responderAoPedidoDeReserva(m.p, "sim")).toEqual({ acao: "ja_fechada" });
    expect(m.eventos).toEqual(["fechar:confirmada"]);
    expect(m.paciente).toEqual([]);
    expect(m.secretaria).toEqual([]);
  });

  it("'sim' DEPOIS da validade não marca nada: a secretaria ouve que venceu", async () => {
    const m = portas({ reserva: { expiraEm: new Date("2026-11-18T14:59:00Z") } });
    expect(await responderAoPedidoDeReserva(m.p, "sim")).toEqual({ acao: "vencida_antes_da_resposta" });
    expect(m.eventos).toEqual([]);
    expect(m.paciente).toEqual([]);
    expect(m.secretaria[0]).toMatch(/já venceu/);
  });

  it("reserva que já não está aguardando (outra via fechou) também não vale", async () => {
    const m = portas({ reserva: { status: "expirada" } });
    expect(await responderAoPedidoDeReserva(m.p, "sim")).toEqual({ acao: "vencida_antes_da_resposta" });
    expect(m.eventos).toEqual([]);
  });

  it("horário tomado no CRM entre a pergunta e o 'sim': desfaz, oferece outros ao paciente e conta à secretaria", async () => {
    const m = portas({ marcacao: { ok: false } });
    const r = await responderAoPedidoDeReserva(m.p, "sim");
    expect(r).toEqual({ acao: "conflito_ao_marcar", alternativas: 2 });
    expect(m.eventos).toEqual(["fechar:confirmada", "marcar", "reverter"]);
    expect(m.paciente[0]).toMatch(/esse horário acabou de ser preenchido/);
    expect(m.secretaria[0]).toMatch(/Não consegui anotar.*acabou de ser ocupado/);
  });
});

describe("responderAoPedidoDeReserva — 'não'", () => {
  it("recusa, oferece DOIS horários parecidos ao paciente (texto fixo) e avisa a secretaria", async () => {
    const m = portas();
    const r = await responderAoPedidoDeReserva(m.p, "nao");
    expect(r).toEqual({ acao: "recusada", alternativas: 2 });
    expect(m.eventos).toEqual(["fechar:recusada"]);
    expect(m.paciente[0]).toMatch(/Poxa, Maria, esse horário acabou de ser preenchido\. Tenho disponível .* ou .*\. Qual deles/);
    expect(m.secretaria[0]).toMatch(/avisei Maria da Silva/);
    expect(m.equipe).toEqual([]);
  });

  it("com UM só horário parecido, pergunta se serve", async () => {
    const m = portas({ alternativas: [ALTERNATIVAS[0]!] });
    await responderAoPedidoDeReserva(m.p, "nao");
    expect(m.paciente[0]).toMatch(/Tenho disponível [^.]*\. Esse horário serve para você\?/);
  });

  it("SEM nenhum horário parecido: o paciente ouve que a recepção vai chamar e a equipe é avisada", async () => {
    const m = portas({ alternativas: [] });
    const r = await responderAoPedidoDeReserva(m.p, "nao");
    expect(r).toEqual({ acao: "recusada", alternativas: 0 });
    expect(m.paciente[0]).toMatch(/recepção te chamar/);
    expect(m.equipe).toHaveLength(1);
  });

  it("quem perde a corrida do fechamento não fala com ninguém", async () => {
    const m = portas({ fechaGanha: false });
    expect(await responderAoPedidoDeReserva(m.p, "nao")).toEqual({ acao: "ja_fechada" });
    expect(m.paciente).toEqual([]);
    expect(m.secretaria).toEqual([]);
  });
});

describe("vencerReserva — a secretaria não respondeu (o cron já fechou como expirada)", () => {
  it("o paciente recebe horários parecidos, a equipe é chamada e a secretaria é informada", async () => {
    const m = portas({ reserva: { status: "expirada" } });
    const r = await vencerReserva(m.p);
    expect(r).toEqual({ acao: "vencimento", alternativas: 2 });
    // Quem fechou foi o cron: aqui não se reivindica nada.
    expect(m.eventos).toEqual([]);
    expect(m.paciente[0]).toMatch(/esse horário acabou de ser preenchido/);
    expect(m.equipe).toEqual(["A secretaria não respondeu ao pedido de horário de Maria da Silva"]);
    expect(m.secretaria[0]).toMatch(/venceu sem resposta/);
  });

  it("sem horário parecido a equipe é chamada DUAS vezes com assuntos diferentes (sem horário; sem resposta)", async () => {
    const m = portas({ reserva: { status: "expirada" }, alternativas: [] });
    await vencerReserva(m.p);
    expect(m.equipe).toHaveLength(2);
  });
});
