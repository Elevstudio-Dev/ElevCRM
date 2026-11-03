import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";

/**
 * A CONSULTA REAL DE ELEGIBILIDADE, contra o banco real: marcar o contato como "fora do funil" tira a IA da
 * conversa DELE — e só dele.
 *
 * É a consulta que o `drain` (que enfileira o turno) e o turno do agente usam. O unitário prova a regra pura; aqui
 * se prova que a coluna existe, que a consulta a lê e que o marcador chega à decisão.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG = "eeeeeeee-5555-4000-8000-00000000000a";
const SESSAO = "eeeeeeee-5555-4000-8000-0000000000a1";
const CONTATO_EQUIPE = "eeeeeeee-5555-4000-8000-0000000000c1";
const CONTATO_CLIENTE = "eeeeeeee-5555-4000-8000-0000000000c2";
const CONVERSA_EQUIPE = "eeeeeeee-5555-4000-8000-0000000000e1";
const CONVERSA_CLIENTE = "eeeeeeee-5555-4000-8000-0000000000e2";
const AGORA = new Date("2026-10-29T12:00:00Z");

const decidir = (conversationId: string) =>
  decidirElegibilidadeDaConversa(pool, { organizationId: ORG, conversationId, agora: AGORA, ttlMs: 21 * 86_400_000 });

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'elegib-fdf', 'Elegib LTDA', 'Elegib') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, 'elegib-fdf-sess', '\\x00') on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name) values
       ($1, $3, 'Pessoa da equipe'), ($2, $3, 'Cliente')
     on conflict (id) do nothing`,
    [CONTATO_EQUIPE, CONTATO_CLIENTE, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status) values
       ($1, $3, $4, $5, 'open'), ($2, $3, $6, $5, 'open')
     on conflict (id) do nothing`,
    [CONVERSA_EQUIPE, CONVERSA_CLIENTE, ORG, CONTATO_EQUIPE, SESSAO, CONTATO_CLIENTE],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("decidirElegibilidadeDaConversa e o contato fora do funil", () => {
  it("controle: contato do funil, canal aberto → a IA pode atender", async () => {
    expect(await decidir(CONVERSA_EQUIPE)).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });

  it("marcar tira a IA DESSA conversa, com o motivo certo, e não toca na do cliente", async () => {
    await pool.query("update contacts set fora_do_funil_em = now() where id = $1", [CONTATO_EQUIPE]);
    expect(await decidir(CONVERSA_EQUIPE)).toEqual({
      permite: false,
      motivo: "fora_do_funil",
      bloqueioPorAllowlist: false,
    });
    expect(await decidir(CONVERSA_CLIENTE)).toMatchObject({ permite: true });
  });

  it("vale mesmo com a allowlist autorizando o contato (nenhuma origem elegível o traz de volta)", async () => {
    await pool.query("update channel_sessions set metadata = jsonb_build_object('ai_gate', 'allowlist') where id = $1", [SESSAO]);
    await pool.query("update contacts set ai_authorized_at = now() where id = $1", [CONTATO_EQUIPE]);
    expect((await decidir(CONVERSA_EQUIPE))?.motivo).toBe("fora_do_funil");
    await pool.query("update channel_sessions set metadata = '{}'::jsonb where id = $1", [SESSAO]);
  });

  it("desmarcar devolve a IA", async () => {
    await pool.query("update contacts set fora_do_funil_em = null where id = $1", [CONTATO_EQUIPE]);
    expect(await decidir(CONVERSA_EQUIPE)).toMatchObject({ permite: true });
  });
});
