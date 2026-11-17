// @vitest-environment node
import { describe, expect, it } from "vitest";

import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { diaLocalISO } from "@/lib/agenda/fuso";

/**
 * A CONSULTA DE HORÁRIOS COM A AGENDA DA SECRETARIA.
 *
 * Só a IA liga `exigirAgendaConferida`. A tela do operador NÃO liga: quem marca à mão enxerga a agenda e decide, e
 * travá-lo porque a secretaria não respondeu seria o sistema mandando no humano. Aqui roda a consulta INTEIRA (jornada,
 * exceções, ocupados, tipo) contra um banco de mentira por tabela — só o carimbo da última conferência varia.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T15:00:00Z"); // quarta, 12h em Brasília
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

interface Mundo {
  secretariaAtiva: boolean;
  conferidoEm: string | null;
}

/** O expediente da clínica-piloto: 8h–12h e 13h30–19h, de segunda a sexta. */
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

function supabaseDe(mundo: Mundo) {
  return {
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        organizations: { settings: mundo.secretariaAtiva ? { secretaria: { ativa: true } } : {} },
        calendar_event_types: TIPO,
        attendant_availability: { schedule: JORNADA },
      };
      const lista: Record<string, unknown[]> = {
        agenda_relatos: mundo.conferidoEm ? [{ conferido_em: mundo.conferidoEm }] : [],
      };
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

const consultar = (mundo: Mundo, exigir: boolean | undefined) =>
  horariosLivresDaOrg(supabaseDe(mundo), "org-1", {
    eventTypeSlug: "avaliacao-gratuita",
    de: AGORA,
    ate: new Date(AGORA.getTime() + 7 * 86_400_000),
    agora: AGORA,
    ...(exigir === undefined ? {} : { exigirAgendaConferida: exigir }),
  });

const HOJE = diaLocalISO(AGORA, FUSO);

describe("horariosLivresDaOrg — exigirAgendaConferida", () => {
  it("SEM exigir (a tela do operador): a agenda nunca conferida NÃO trava nada", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: null }, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.agendaDaSecretaria).toBeUndefined();
  });

  it("exigindo, mas a organização NÃO usa a secretaria: a regra não existe", async () => {
    const r = await consultar({ secretariaAtiva: false, conferidoEm: null }, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agendaDaSecretaria).toBe("sem_secretaria");
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("exigindo e NUNCA conferida: recusa com código próprio e a frase do CLIENTE manda não oferecer horário", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: null }, true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("agenda_desatualizada");
    expect(r.motivoParaCliente).toMatch(/não ofereça horários/i);
    // A face do cliente nunca nomeia campo nem configuração (DECISÃO 20).
    expect(r.motivoParaCliente).not.toMatch(/settings|secretaria\.ativa|agenda_relatos/i);
    expect(r.motivoParaOperador).toMatch(/secretaria/i);
  });

  it("conferida há 1h: 'atual', e os horários de HOJE ainda aparecem", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: horasAtras(1) }, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agendaDaSecretaria).toBe("atual");
    expect(r.slots.some((s) => diaLocalISO(s.inicio, FUSO) === HOJE)).toBe(true);
  });

  it("conferida há 10h (passou da validade de hoje): 'sem_hoje' — nenhum horário de hoje, os dos dias seguintes seguem", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: horasAtras(10) }, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agendaDaSecretaria).toBe("sem_hoje");
    expect(r.slots.some((s) => diaLocalISO(s.inicio, FUSO) === HOJE)).toBe(false);
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("conferida há 30h (passou da validade dos dias seguintes): recusa", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: horasAtras(30) }, true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("agenda_desatualizada");
  });

  it("o expediente 8h–12h e 13h30–19h continua sendo respeitado: nada às 12h30 nem depois das 19h", async () => {
    const r = await consultar({ secretariaAtiva: true, conferidoEm: horasAtras(1) }, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const horas = r.slots.map((s) => {
      const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hour12: false }).format(s.inicio).slice(0, 2));
      const mm = Number(new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hour12: false }).format(s.inicio).slice(3, 5));
      return hh * 60 + mm;
    });
    for (const m of horas) {
      const naManha = m >= 8 * 60 && m + 30 <= 12 * 60;
      const naTarde = m >= 13 * 60 + 30 && m + 30 <= 19 * 60;
      expect(naManha || naTarde).toBe(true);
    }
  });
});
