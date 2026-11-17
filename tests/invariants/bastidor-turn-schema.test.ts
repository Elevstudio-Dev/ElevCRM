import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { enqueueJob } from "@/lib/agent-engine/queue/queue";

/**
 * O schema do turno de BASTIDOR (migration 0229): a IA conversando com a equipe.
 *
 * O que pode quebrar aqui é CONSTRAINT, e constraint só existe no Postgres. São dois CHECKs, e o segundo é o que
 * morre calado (mesma lição do `operator_turn`, migration 0111):
 *
 *   1. `job_queue_kind_check` — o kind novo é aceito;
 *   2. `job_queue_turn_needs_contact` — coerência kind ⇔ contato.
 *
 * Esquecer o (2): o kind passa a existir, tudo compila, e TODO insert de `bastidor_turn` viola a constraint em
 * produção. A secretaria manda a agenda e nada acontece, sem erro na tela.
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh` com o `baseline.sql` aplicado (o MESMO arquivo que o kit
 * self-host instala), então também prova que a mudança chegou ao apêndice, não só às migrations.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0be7a70a-0000-4000-8000-0000000000b1";
const CONTACT = "0be7a70a-0000-4000-8000-0000000000b2";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-bastidor-teste', 'Org Bastidor LTDA', 'Org Bastidor')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Secretaria do Bastidor', '+5511900000922')
     on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where id = $1", [CONTACT]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("job_queue aceita o bastidor_turn", () => {
  it("aceita kind 'bastidor_turn' com contato — o caminho que o drain usa", async () => {
    const { job } = await enqueueJob(pool, ORG, {
      kind: "bastidor_turn",
      leadId: CONTACT,
      payload: { conversation_id: "x" },
    });
    expect(job.kind).toBe("bastidor_turn");
    expect(job.contact_id).toBe(CONTACT);
  });

  it("REJEITA 'bastidor_turn' sem contato — conversar com a equipe sem saber com quem não existe", async () => {
    await expect(
      pool.query(
        `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, null, 'bastidor_turn', '{}')`,
        [ORG],
      ),
    ).rejects.toThrow(/job_queue_turn_needs_contact/);
  });

  it("os kinds antigos continuam valendo (a constraint foi estendida, não trocada)", async () => {
    for (const kind of ["inbound_turn", "followup_turn", "case_reply_turn", "operator_turn"] as const) {
      const { job } = await enqueueJob(pool, ORG, { kind, leadId: CONTACT, payload: {} });
      expect(job.kind).toBe(kind);
    }
    const { job } = await enqueueJob(pool, ORG, { kind: "watchdog", payload: {} });
    expect(job.contact_id).toBeNull();
  });

  it("um kind inventado continua sendo recusado", async () => {
    await expect(
      pool.query(
        `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, $2, 'qualquer_coisa', '{}')`,
        [ORG, CONTACT],
      ),
    ).rejects.toThrow(/job_queue_kind_check/);
  });
});
