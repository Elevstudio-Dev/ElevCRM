// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  escolherHorariosParecidos,
  minutosParaVencer,
  reservaValeAinda,
  reservasQueOcupam,
} from "@/lib/agenda/secretaria/reservas";

/**
 * O QUE UMA RESERVA FAZ COM A AGENDA — dois fatos que sustentam a conversa inteira:
 *
 *  1. Horário SEGURADO (reserva esperando a secretaria, dentro da validade) não é oferecido a ninguém; passou a
 *     validade, volta a ser livre. Horário RECUSADO pela secretaria também não é re-oferecido — até que a agenda seja
 *     conferida de novo, que é mais nova que a recusa e passa a mandar.
 *  2. Os horários parecidos que o paciente recebe vêm do servidor: um no mesmo dia, outro em outro dia, nunca o
 *     pedido e nunca um que já passou.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T15:00:00Z"); // quarta, 12h em Brasília
const iso = (s: string) => new Date(s).toISOString();

type Linha = Record<string, unknown>;
function supabaseDe(tabelas: Record<string, Linha[]>) {
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "lte", "gt", "lt", "in", "not", "is", "or", "order", "limit"]) {
        q[m] = () => q;
      }
      q.then = (ok: (v: unknown) => unknown) => ok({ data: tabelas[tabela] ?? [], error: null });
      return q;
    },
  } as never;
}

const JANELA = { de: new Date("2026-11-18T00:00:00Z"), ate: new Date("2026-11-25T00:00:00Z") };
const reserva = (extra: Linha) => ({
  id: "r1",
  starts_at: iso("2026-11-19T17:00:00Z"),
  ends_at: iso("2026-11-19T17:30:00Z"),
  status: "aguardando_secretaria",
  expira_em: iso("2026-11-18T15:10:00Z"),
  respondida_em: null,
  ...extra,
});

describe("reservasQueOcupam — o que a reserva segura", () => {
  it("reserva esperando a secretaria, dentro da validade, SEGURA o horário", async () => {
    const r = await reservasQueOcupam(supabaseDe({ agenda_reservas_pendentes: [reserva({})] }), "org", "dono", JANELA, AGORA);
    expect(r).toEqual([{ starts_at: iso("2026-11-19T17:00:00Z"), ends_at: iso("2026-11-19T17:30:00Z"), status: "confirmed" }]);
  });

  it("passou a validade e ninguém varreu ainda: o horário já voltou a ser livre", async () => {
    const vencida = reserva({ expira_em: iso("2026-11-18T14:59:00Z") });
    const r = await reservasQueOcupam(supabaseDe({ agenda_reservas_pendentes: [vencida] }), "org", "dono", JANELA, AGORA);
    expect(r).toEqual([]);
  });

  it("a reserva que está sendo CONFIRMADA não segura o próprio horário", async () => {
    const r = await reservasQueOcupam(supabaseDe({ agenda_reservas_pendentes: [reserva({})] }), "org", "dono", JANELA, AGORA, "r1");
    expect(r).toEqual([]);
  });

  it("horário RECUSADO pela secretaria continua ocupado enquanto a agenda não for conferida de novo", async () => {
    const recusada = reserva({ status: "recusada", respondida_em: iso("2026-11-18T14:50:00Z") });
    const semConferencia = await reservasQueOcupam(
      supabaseDe({ agenda_reservas_pendentes: [recusada], agenda_relatos: [] }),
      "org", "dono", JANELA, AGORA,
    );
    expect(semConferencia).toHaveLength(1);

    const conferidaAntes = await reservasQueOcupam(
      supabaseDe({ agenda_reservas_pendentes: [recusada], agenda_relatos: [{ conferido_em: iso("2026-11-18T08:30:00Z") }] }),
      "org", "dono", JANELA, AGORA,
    );
    expect(conferidaAntes).toHaveLength(1); // a conferência é MAIS VELHA que a recusa: a recusa manda
  });

  it("agenda conferida DEPOIS da recusa devolve o horário (a conferência é mais nova)", async () => {
    const recusada = reserva({ status: "recusada", respondida_em: iso("2026-11-18T14:50:00Z") });
    const r = await reservasQueOcupam(
      supabaseDe({ agenda_reservas_pendentes: [recusada], agenda_relatos: [{ conferido_em: iso("2026-11-18T14:55:00Z") }] }),
      "org", "dono", JANELA, AGORA,
    );
    expect(r).toEqual([]);
  });

  it("erro do banco propaga (a consulta de horários falha fechada, não oferece no escuro)", async () => {
    const quebrado = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "lt", "gt"]) q[m] = () => q;
        q.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "boom" } });
        return q;
      },
    } as never;
    await expect(reservasQueOcupam(quebrado, "org", "dono", JANELA, AGORA)).rejects.toThrow(/boom/);
  });
});

describe("reservaValeAinda / minutosParaVencer", () => {
  const base = { status: "aguardando_secretaria" as const, expiraEm: new Date("2026-11-18T15:10:00Z") };
  it("vale enquanto aguardando e antes da validade", () => {
    expect(reservaValeAinda(base, AGORA)).toBe(true);
    expect(reservaValeAinda(base, new Date("2026-11-18T15:10:00Z"))).toBe(false);
    expect(reservaValeAinda({ ...base, status: "confirmada" as never }, AGORA)).toBe(false);
  });
  it("conta os minutos que faltam, sem passar de zero", () => {
    expect(minutosParaVencer(base, AGORA)).toBe(10);
    expect(minutosParaVencer(base, new Date("2026-11-18T16:00:00Z"))).toBe(0);
  });
});

describe("escolherHorariosParecidos — o que o paciente recebe quando o horário não deu", () => {
  const h = (s: string) => ({ inicio: new Date(s), fim: new Date(new Date(s).getTime() + 30 * 60_000) });
  // Pedido: quinta 19/11 às 14h (17:00Z). Quinta 14:30 e 16h livres; sexta 14h livre; segunda 14h livre.
  const pedido = new Date("2026-11-19T17:00:00Z");
  const livres = [
    h("2026-11-19T17:00:00Z"), // o próprio pedido: nunca volta
    h("2026-11-19T17:30:00Z"), // quinta 14:30
    h("2026-11-19T19:00:00Z"), // quinta 16:00
    h("2026-11-20T17:00:00Z"), // sexta 14:00
    h("2026-11-23T17:00:00Z"), // segunda 14:00
  ];

  it("um no MESMO dia (o mais perto) e outro em OUTRO dia (o mais perto, na mesma hora), em ordem", () => {
    const r = escolherHorariosParecidos(livres, pedido, FUSO, AGORA, 2);
    expect(r.map((s) => s.inicio.toISOString())).toEqual(["2026-11-19T17:30:00.000Z", "2026-11-20T17:00:00.000Z"]);
  });

  it("nunca devolve o horário pedido", () => {
    const r = escolherHorariosParecidos(livres, pedido, FUSO, AGORA, 5);
    expect(r.some((s) => s.inicio.getTime() === pedido.getTime())).toBe(false);
  });

  it("nunca devolve horário que já passou", () => {
    const r = escolherHorariosParecidos([h("2026-11-18T14:00:00Z"), h("2026-11-20T17:00:00Z")], pedido, FUSO, AGORA, 2);
    expect(r.map((s) => s.inicio.toISOString())).toEqual(["2026-11-20T17:00:00.000Z"]);
  });

  it("sem nada no mesmo dia, completa com o mais perto no tempo", () => {
    const r = escolherHorariosParecidos([h("2026-11-20T17:00:00Z"), h("2026-11-23T17:00:00Z")], pedido, FUSO, AGORA, 2);
    expect(r.map((s) => s.inicio.toISOString())).toEqual(["2026-11-20T17:00:00.000Z", "2026-11-23T17:00:00.000Z"]);
  });

  it("sem candidato nenhum, devolve vazio (a equipe é chamada)", () => {
    expect(escolherHorariosParecidos([h("2026-11-19T17:00:00Z")], pedido, FUSO, AGORA, 2)).toEqual([]);
    expect(escolherHorariosParecidos([], pedido, FUSO, AGORA, 2)).toEqual([]);
  });

  it("respeita a quantidade pedida", () => {
    expect(escolherHorariosParecidos(livres, pedido, FUSO, AGORA, 1)).toHaveLength(1);
  });
});
