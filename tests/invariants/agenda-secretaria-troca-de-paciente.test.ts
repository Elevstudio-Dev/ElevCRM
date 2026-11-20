import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { aplicarRelato } from "@/lib/agenda/secretaria/aplicar";
import { conferirEAplicarRelato } from "@/lib/agenda/secretaria/relatos";
import type { RelatoLido } from "@/lib/agenda/secretaria/relato";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A FALHA DE PRODUÇÃO da agenda da secretaria, reproduzida contra o Postgres de verdade.
 *
 * O aplicador fazia "criar antes de cancelar". Quando o relato novo troca o paciente de um MESMO horário (08:30 saía
 * um, entrava outro), o insert do novo batia no antigo — que só seria cancelado depois — no índice único
 * `calendar_appointments_sem_duplicata_idx (organization_id, owner_user_id, starts_at)`: `duplicate key`, o job
 * tentava 5 vezes e morria, e a agenda ficava sem atualizar. Só o banco tem esse índice: o teste unitário com
 * cliente de mentira nunca o veria.
 *
 * O cliente é `pgComoSupabase` (o aplicador roda DE VERDADE, só o transporte muda). Dados 100% sintéticos.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });
const db = pgComoSupabase(pool);

const ORG = "a9e4da00-0000-4000-8000-000000000001";
const DONO = "a9e4da00-0000-4000-8000-000000000002";
const RELATO_VELHO = "a9e4da00-0000-4000-8000-0000000000a1";
const RELATO_NOVO = "a9e4da00-0000-4000-8000-0000000000a2";
const FUSO = "America/Sao_Paulo";
/** 07h de quarta 18/11 em Brasília: tudo do relato ainda está no futuro. */
const AGORA = new Date("2026-11-18T10:00:00Z");

// Os horários do caso de produção (em UTC; Brasília = UTC-3).
const H_0830 = "2026-11-18T11:30:00.000Z"; // qua 08h30
const H_1530 = "2026-11-18T18:30:00.000Z"; // qua 15h30
const H_MANTIDO = "2026-11-19T13:00:00.000Z"; // qui 10h
const H_SUMIU = "2026-11-19T14:00:00.000Z"; // qui 11h
const H_VENDAS = "2026-11-19T19:00:00.000Z"; // qui 16h — marcado pela IA de vendas, NÃO por relato

const RELATO_NOVO_LIDO: RelatoLido = {
  janela: { de: "2026-11-18", ate: "2026-11-20" },
  marcados: [
    { nome: "Paciente C", inicio: H_0830 }, // troca o A
    { nome: "Paciente D", inicio: H_1530 }, // troca o B
    { nome: "Paciente E", inicio: H_MANTIDO }, // mantido
    // o F (qui 11h) sumiu: a secretaria desmarcou
  ],
  dias_fechados: [{ data: "2026-11-20", motivo: "feriado" }],
  duvidas: [],
};

async function compromissoDoRelato(id: string, nome: string, inicio: string, relato = RELATO_VELHO) {
  await pool.query(
    `insert into calendar_appointments
       (id, organization_id, title, starts_at, ends_at, time_zone, status, owner_user_id,
        created_by_kind, source, origem_relato_id, google_synced_at)
     values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes', $5, 'confirmed', $6,
             'ai', 'mcp', $7, now())`,
    [id, ORG, nome, inicio, FUSO, DONO, relato],
  );
}

const vivos = async () =>
  (
    await pool.query<{ title: string; starts_at: Date; origem_relato_id: string | null }>(
      `select title, starts_at, origem_relato_id from calendar_appointments
        where organization_id = $1 and status in ('pending','confirmed') order by starts_at, title`,
      [ORG],
    )
  ).rows.map((r) => `${r.starts_at.toISOString()} ${r.title}${r.origem_relato_id === RELATO_NOVO ? " (novo)" : ""}`);

beforeAll(async () => {
  await pool.query(`insert into auth.users (id, email) values ($1, 'dono-troca@invariant.test') on conflict do nothing`, [DONO]);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, settings)
     values ($1, 'org-troca-paciente', 'Troca de Paciente LTDA', 'Troca', $2,
             jsonb_build_object('secretaria', jsonb_build_object('ativa', true, 'dono_da_agenda_user_id', $3::text, 'duracao_min', 30)))
     on conflict (id) do nothing`,
    [ORG, FUSO, DONO],
  );
});

beforeEach(async () => {
  await pool.query(`delete from calendar_appointments where organization_id = $1`, [ORG]);
  await pool.query(`delete from calendar_availability_exceptions where organization_id = $1`, [ORG]);
  await pool.query(`delete from agenda_relatos where organization_id = $1`, [ORG]);
  await pool.query(
    `insert into agenda_relatos (id, organization_id, texto, lido, janela_de, janela_ate, estado, conferido_em)
     values ($1, $2, 'relato antigo', '{}'::jsonb, '2026-11-18', '2026-11-20', 'conferido', now())`,
    [RELATO_VELHO, ORG],
  );
  await pool.query(
    `insert into agenda_relatos (id, organization_id, texto, lido, janela_de, janela_ate, estado)
     values ($1, $2, 'relato novo', $3::jsonb, '2026-11-18', '2026-11-20', 'lido')`,
    [RELATO_NOVO, ORG, JSON.stringify(RELATO_NOVO_LIDO)],
  );
  // O relato antigo, já conferido: A às 08h30, B às 15h30, E mantido, F que vai sumir.
  await compromissoDoRelato("a9e4da00-0000-4000-8000-0000000000c1", "Paciente A", H_0830);
  await compromissoDoRelato("a9e4da00-0000-4000-8000-0000000000c2", "Paciente B", H_1530);
  await compromissoDoRelato("a9e4da00-0000-4000-8000-0000000000c3", "Paciente E", H_MANTIDO);
  await compromissoDoRelato("a9e4da00-0000-4000-8000-0000000000c4", "Paciente F", H_SUMIU);
});

afterAll(async () => {
  await pool.query(`drop trigger if exists trg_teste_falha_no_insert on calendar_appointments`);
  await pool.query(`drop function if exists fn_teste_falha_no_insert()`);
  await pool.end();
});

describe("o caso de produção: o relato novo troca o paciente de um MESMO horário", () => {
  it("o 'sim' APLICA sem erro: troca A→C e B→D, mantém E, cancela F, fecha o dia — e marca o relato conferido", async () => {
    const r = await conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA });

    expect(r).toMatchObject({ jaConferido: false, criados: 2, mantidos: 1, cancelados: 3, diasFechados: 1, diasReabertos: 0 });
    expect(r.conflitos).toEqual([]);
    expect(await vivos()).toEqual([
      `${H_0830} Paciente C (novo)`,
      `${H_1530} Paciente D (novo)`,
      `${H_MANTIDO} Paciente E`,
    ]);
    const { rows: cancelados } = await pool.query<{ title: string; reason: string }>(
      `select title, cancellation_reason as reason from calendar_appointments
        where organization_id = $1 and status = 'cancelled' order by title`,
      [ORG],
    );
    expect(cancelados.map((c) => c.title)).toEqual(["Paciente A", "Paciente B", "Paciente F"]);
    expect(cancelados.every((c) => /relato da secretaria/i.test(c.reason))).toBe(true);

    const { rows: dias } = await pool.query<{ d: string; reason: string }>(
      `select exception_date::text as d, reason from calendar_availability_exceptions where organization_id = $1`,
      [ORG],
    );
    expect(dias).toEqual([{ d: "2026-11-20", reason: "[secretaria] feriado" }]);

    const { rows: relato } = await pool.query<{ estado: string }>(`select estado from agenda_relatos where id = $1`, [RELATO_NOVO]);
    expect(relato[0]!.estado).toBe("conferido");
  });

  it("reexecutar depois de aplicado não muda nada (idempotente)", async () => {
    await conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA });
    const antes = await vivos();
    const deNovo = await aplicarRelato(db, {
      organizationId: ORG,
      relatoId: RELATO_NOVO,
      donoUserId: DONO,
      relato: RELATO_NOVO_LIDO,
      fuso: FUSO,
      duracaoMin: 30,
      agora: AGORA,
    });
    expect(deNovo).toMatchObject({ criados: 0, mantidos: 3, cancelados: 0, diasFechados: 0 });
    expect(await vivos()).toEqual(antes);
  });

  it("se o INSERT falhar depois de cancelar o antigo, o antigo VOLTA — a agenda nunca fica com menos do que ela disse", async () => {
    // Uma falha real do banco no meio do caminho: o trigger recusa o insert do Paciente C.
    await pool.query(`
      create or replace function fn_teste_falha_no_insert() returns trigger language plpgsql as $$
      begin
        if new.title = 'Paciente C' then raise exception 'falha simulada no insert'; end if;
        return new;
      end $$;
      drop trigger if exists trg_teste_falha_no_insert on calendar_appointments;
      create trigger trg_teste_falha_no_insert before insert on calendar_appointments
        for each row execute function fn_teste_falha_no_insert();
    `);
    try {
      await expect(
        conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA }),
      ).rejects.toThrow(/criar compromissos do relato/);
    } finally {
      await pool.query(`drop trigger if exists trg_teste_falha_no_insert on calendar_appointments`);
    }
    // Tudo como estava: A e B de volta (vivos), E mantido, F ainda vivo (o cancelamento comum vem DEPOIS do criar).
    expect(await vivos()).toEqual([
      `${H_0830} Paciente A`,
      `${H_1530} Paciente B`,
      `${H_MANTIDO} Paciente E`,
      `${H_SUMIU} Paciente F`,
    ]);
    const { rows } = await pool.query<{ estado: string }>(`select estado from agenda_relatos where id = $1`, [RELATO_NOVO]);
    expect(rows[0]!.estado, "o relato continua esperando: rodar de novo é seguro").toBe("lido");

    // E rodar de novo, com o banco bom, aplica.
    const r = await conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA });
    expect(r).toMatchObject({ criados: 2, cancelados: 3 });
  });
});

describe("colisão com um compromisso que NÃO veio de relato (ex.: marcado pela IA de vendas)", () => {
  const COMPROMISSO_DE_VENDAS = "a9e4da00-0000-4000-8000-0000000000d1";

  beforeEach(async () => {
    await pool.query(
      `insert into calendar_appointments
         (id, organization_id, title, starts_at, ends_at, time_zone, status, owner_user_id, created_by_kind, source)
       values ($1, $2, 'Consulta marcada pela IA', $3::timestamptz, $3::timestamptz + interval '30 minutes', $4,
               'confirmed', $5, 'ai', 'mcp')`,
      [COMPROMISSO_DE_VENDAS, ORG, H_VENDAS, FUSO, DONO],
    );
    await pool.query(`update agenda_relatos set lido = $2::jsonb where id = $1`, [
      RELATO_NOVO,
      JSON.stringify({
        ...RELATO_NOVO_LIDO,
        marcados: [...RELATO_NOVO_LIDO.marcados, { nome: "Paciente H", inicio: H_VENDAS }],
      }),
    ]);
  });

  it("a conferência NÃO cai: aplica o resto, não cria o espelho daquele horário e devolve o conflito", async () => {
    const r = await conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA });
    expect(r).toMatchObject({ criados: 2, mantidos: 1, cancelados: 3, diasFechados: 1 });
    expect(r.conflitos).toEqual([{ inicio: H_VENDAS, nome: "Paciente H", porque: "outro_compromisso" }]);
    const { rows } = await pool.query<{ estado: string }>(`select estado from agenda_relatos where id = $1`, [RELATO_NOVO]);
    expect(rows[0]!.estado).toBe("conferido");
  });

  it("o compromisso que não é do relato fica INTACTO (nem cancelado, nem renomeado)", async () => {
    await conferirEAplicarRelato(db, { organizationId: ORG, relatoId: RELATO_NOVO, agora: AGORA });
    const { rows } = await pool.query<{ status: string; title: string; origem: string | null }>(
      `select status, title, origem_relato_id as origem from calendar_appointments where id = $1`,
      [COMPROMISSO_DE_VENDAS],
    );
    expect(rows[0]).toEqual({ status: "confirmed", title: "Consulta marcada pela IA", origem: null });
  });
});
