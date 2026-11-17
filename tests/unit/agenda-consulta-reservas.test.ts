// @vitest-environment node
import { describe, expect, it } from "vitest";

import { horariosLivresDaOrg } from "@/lib/agenda/consulta";

/**
 * A CONSULTA DE HORÁRIOS COM UMA RESERVA SEGURANDO UM HORÁRIO.
 *
 * Roda a consulta INTEIRA (tipo, jornada, exceções, ocupados) contra um banco de mentira por tabela e varia só as
 * linhas de `agenda_reservas_pendentes`. O que se prova:
 *
 *  - o horário segurado por um paciente que espera a secretaria NÃO aparece — nem para a IA, nem para a tela;
 *  - o resto do dia continua livre (a reserva segura só o horário dela);
 *  - a reserva que está sendo CONFIRMADA é ignorada, senão o servidor não conseguiria marcar o que ela guarda;
 *  - sem reserva, a consulta é a de sempre.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T15:00:00Z"); // quarta, 12h em Brasília
const QUINTA_14H = "2026-11-19T17:00:00.000Z";

const JORNADA = {
  timezone: FUSO,
  windows: [1, 2, 3, 4, 5].flatMap((dow) => [
    { dow, start: "08:00", end: "12:00" },
    { dow, start: "13:30", end: "19:00" },
  ]),
};

const TIPO = {
  id: "tipo-1",
  name: "Avaliação gratuita",
  is_active: true,
  duration_minutes: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  minimum_notice_minutes: 0,
  slot_interval_minutes: null,
  booking_window_days: 60,
  default_owner_user_id: "dono-1",
};

const reserva = (extra: Record<string, unknown> = {}) => ({
  id: "res-1",
  starts_at: QUINTA_14H,
  ends_at: "2026-11-19T17:30:00.000Z",
  status: "aguardando_secretaria",
  expira_em: "2026-11-18T15:10:00.000Z",
  respondida_em: null,
  ...extra,
});

function supabaseDe(reservas: unknown[]) {
  return {
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        organizations: { settings: {} },
        calendar_event_types: TIPO,
        attendant_availability: { schedule: JORNADA },
      };
      const lista: Record<string, unknown[]> = { agenda_reservas_pendentes: reservas };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "lte", "gt", "lt", "in", "not", "is", "or", "order", "limit"]) {
        q[m] = () => q;
      }
      q.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      q.then = (ok: (v: unknown) => unknown) => ok({ data: lista[tabela] ?? [], error: null });
      return q;
    },
  } as never;
}

const consultar = (reservas: unknown[], ignorarReservaId?: string) =>
  horariosLivresDaOrg(supabaseDe(reservas), "org-1", {
    eventTypeSlug: "avaliacao-gratuita",
    de: AGORA,
    ate: new Date(AGORA.getTime() + 7 * 86_400_000),
    agora: AGORA,
    ...(ignorarReservaId ? { ignorarReservaId } : {}),
  });

const inicios = (r: Awaited<ReturnType<typeof consultar>>) => (r.ok ? r.slots.map((s) => s.inicio.toISOString()) : []);

describe("horariosLivresDaOrg × reserva que espera a secretaria", () => {
  it("CONTROLE: sem reserva, quinta 14h é livre", async () => {
    expect(inicios(await consultar([]))).toContain(QUINTA_14H);
  });

  it("com a reserva segurando, quinta 14h SAI da lista — e o resto do dia continua", async () => {
    const livres = inicios(await consultar([reserva()]));
    expect(livres).not.toContain(QUINTA_14H);
    expect(livres).toContain("2026-11-19T16:30:00.000Z"); // 13h30
    expect(livres).toContain("2026-11-19T17:30:00.000Z"); // 14h30
  });

  it("a reserva que está sendo CONFIRMADA não segura o próprio horário", async () => {
    expect(inicios(await consultar([reserva()], "res-1"))).toContain(QUINTA_14H);
  });

  it("passou a validade sem ninguém varrer: o horário já voltou a ser livre", async () => {
    const vencida = reserva({ expira_em: "2026-11-18T14:59:00.000Z" });
    expect(inicios(await consultar([vencida]))).toContain(QUINTA_14H);
  });

  it("outra reserva (ignorada pelo id) não libera a que NÃO é a ignorada", async () => {
    const outra = reserva({ id: "res-2", starts_at: "2026-11-19T18:00:00.000Z", ends_at: "2026-11-19T18:30:00.000Z" });
    const livres = inicios(await consultar([reserva(), outra], "res-1"));
    expect(livres).toContain(QUINTA_14H);
    expect(livres).not.toContain("2026-11-19T18:00:00.000Z");
  });
});
