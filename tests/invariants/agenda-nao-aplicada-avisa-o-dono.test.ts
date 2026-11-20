import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  claimJobs,
  enqueueJob,
  failJob,
  PREFIXO_DA_AGENDA_NAO_APLICADA,
  reapExpiredJobs,
} from "@/lib/agent-engine/queue/queue";

/**
 * A AGENDA QUE A SECRETÁRIA CONFIRMOU NÃO FOI APLICADA — e alguém precisa saber.
 *
 * Produção: o "sim" dela falhou 5 vezes (duplicidade de horário), o job morreu e o único rastro foi um aviso
 * "Job descartado após esgotar tentativas / kind=bastidor_turn; attempts=5" — que o dono do negócio não entende. A
 * secretária achava que estava tudo certo e a IA parou de oferecer horários por mais de 24 h.
 *
 * O aviso nasce DENTRO do statement da fila (`failJob` e o reaper, CTE `alert`), então só o Postgres prova o texto.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG = "a6e9da00-0000-4000-8000-000000000001";
const CONTATO = "a6e9da00-0000-4000-8000-000000000002";
const ERRO_DA_AGENDA = new Error(
  `${PREFIXO_DA_AGENDA_NAO_APLICADA} Motivo: a agenda recusou dois compromissos no mesmo horário do mesmo profissional.`,
);

async function avisos() {
  const { rows } = await pool.query<{ title: string; body: string; severity: string; ref_kind: string }>(
    `select title, body, severity, ref_kind from agent_inbox_items where organization_id = $1 and kind = 'job_dead'`,
    [ORG],
  );
  return rows;
}

async function morrerNaUltimaTentativa(kind: "bastidor_turn" | "inbound_turn", erro: Error) {
  const { job } = await enqueueJob(pool, ORG, { kind, leadId: CONTATO, payload: {}, maxAttempts: 1 });
  const pegos = await claimJobs(pool, { workerId: "agenda", maxConcurrency: 8 });
  expect(pegos.map((j) => j.id)).toContain(job.id);
  const morto = await failJob(pool, job.id, "agenda", erro);
  expect(morto?.status).toBe("dead");
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'org-agenda-nao-aplicada', 'Agenda LTDA', 'Agenda')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Secretaria Sintetica', '+5511900000977')
     on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
});

afterEach(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
});

afterAll(async () => {
  await pool.end();
});

describe("o aviso da Central quando o 'sim' da secretária morre na fila", () => {
  it("título e corpo dizem o que aconteceu, o efeito e o que fazer — com o motivo", async () => {
    await morrerNaUltimaTentativa("bastidor_turn", ERRO_DA_AGENDA);
    const [aviso, ...resto] = await avisos();
    expect(resto).toEqual([]);
    expect(aviso!.severity).toBe("critical");
    expect(aviso!.ref_kind).toBe("job_queue");
    expect(aviso!.title).toBe("A agenda que a secretária confirmou não foi aplicada");
    expect(aviso!.body).toContain("Motivo: a agenda recusou dois compromissos no mesmo horário");
    expect(aviso!.body).toContain("a IA não oferece horários aos pacientes");
    expect(aviso!.body).toMatch(/O que fazer: peça para ela mandar a agenda de novo, ou reprocesse/);
    expect(aviso!.body).toContain("docs/runbooks/agenda-da-secretaria.md");
  });

  it("o reaper (worker morto no meio) usa o MESMO texto", async () => {
    const { job } = await enqueueJob(pool, ORG, { kind: "bastidor_turn", leadId: CONTATO, payload: {}, maxAttempts: 1 });
    await claimJobs(pool, { workerId: "agenda", maxConcurrency: 8 });
    await pool.query(`update job_queue set last_error = $2, locked_at = now() - interval '1 hour' where id = $1`, [
      job.id,
      ERRO_DA_AGENDA.message,
    ]);
    const r = await reapExpiredJobs(pool, { visibilityTimeoutMs: 60_000 });
    expect(r.dead).toBe(1);
    expect((await avisos())[0]!.title).toBe("A agenda que a secretária confirmou não foi aplicada");
  });

  it("qualquer OUTRA falha do bastidor_turn (modelo fora, por ex.) mantém o aviso genérico com o motivo técnico", async () => {
    await morrerNaUltimaTentativa("bastidor_turn", new Error("provedor fora"));
    const [aviso] = await avisos();
    expect(aviso!.title).toBe("Job descartado após esgotar tentativas");
    expect(aviso!.body).toBe("kind=bastidor_turn; attempts=1\nMotivo: provedor fora");
  });

  it("outro kind com a MESMA frase no erro não vira aviso da agenda (o reconhecimento exige bastidor_turn)", async () => {
    await morrerNaUltimaTentativa("inbound_turn", ERRO_DA_AGENDA);
    expect((await avisos())[0]!.title).toBe("Job descartado após esgotar tentativas");
  });
});
