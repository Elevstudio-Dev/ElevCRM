import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { CONFIG_PADRAO_DA_SECRETARIA } from "@/lib/agenda/secretaria/config";
import { portasDoTickNoSupabase } from "@/lib/bastidor/secretaria/perguntas-supabase";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * NO MÁXIMO UM lembrete "falta só você confirmar o resumo" por resumo — e quem garante é o BANCO.
 *
 * O cron roda a cada 5 minutos, pode rodar em duas instâncias, e cada horário de pergunta do dia é uma chance de
 * lembrar. A porta real (`enfileirarLembreteDaConferencia`) enfileira com `source_event_id` = id do relato, e o índice
 * único `uniq_job_queue_source_event (organization_id, source_event_id)` recusa o segundo. Só o Postgres tem o índice.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG = "1e5b0000-0000-4000-8000-000000000001";
const CONTATO = "1e5b0000-0000-4000-8000-000000000002";
const RELATO_1 = "1e5b0000-0000-4000-8000-0000000000a1";
const RELATO_2 = "1e5b0000-0000-4000-8000-0000000000a2";
const RELATO_3 = "1e5b0000-0000-4000-8000-0000000000a3";
const CONVERSA = { conversationId: "1e5b0000-0000-4000-8000-0000000000c1", channelSessionId: "1e5b0000-0000-4000-8000-0000000000c2" };

const portas = () =>
  portasDoTickNoSupabase(pgComoSupabase(pool), () => undefined).portasDe({
    organizationId: ORG,
    contactId: CONTATO,
    nome: "Secretaria Sintetica",
    config: { ...CONFIG_PADRAO_DA_SECRETARIA, ativa: true },
    fuso: "America/Sao_Paulo",
  });

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'org-lembrete-um-so', 'Lembrete LTDA', 'Lembrete')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Secretaria Sintetica', '+5511900000978')
     on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, 'lembrete-um-so', '\\x00', 'WORKING') on conflict (id) do nothing`,
    [CONVERSA.channelSessionId, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [CONVERSA.conversationId, ORG, CONTATO, CONVERSA.channelSessionId],
  );
});

afterAll(async () => {
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.end();
});

describe("o lembrete de confirmar o resumo", () => {
  it("o primeiro entra; o segundo do MESMO resumo é recusado pela fila (falso, sem erro); outro resumo entra", async () => {
    expect(await portas().enfileirarLembreteDaConferencia(RELATO_1, CONVERSA)).toBe(true);
    expect(await portas().enfileirarLembreteDaConferencia(RELATO_1, CONVERSA)).toBe(false);
    expect(await portas().enfileirarLembreteDaConferencia(RELATO_2, CONVERSA)).toBe(true);

    const { rows } = await pool.query<{ kind: string; acao: string; relato: string; status: string }>(
      `select kind, payload->>'acao' as acao, payload->>'relato_id' as relato, status
         from job_queue where organization_id = $1 order by created_at`,
      [ORG],
    );
    expect(rows).toEqual([
      { kind: "bastidor_turn", acao: "lembrar_conferencia", relato: RELATO_1, status: "pending" },
      { kind: "bastidor_turn", acao: "lembrar_conferencia", relato: RELATO_2, status: "pending" },
    ]);
  });

  it("M2: 'lembrete enviado' é a MENSAGEM que saiu — job concluído SEM envio (ela já tinha respondido, o handler pulou) não conta", async () => {
    expect(await portas().lembreteDaConferenciaEnviadoEm(RELATO_1)).toBeNull(); // ainda pendente
    // O caso que gerava aviso falso: ela respondeu, o handler DISPENSOU o lembrete e o job terminou `done`.
    await pool.query(`update job_queue set status = 'done' where organization_id = $1 and source_event_id = $2`, [ORG, RELATO_1]);
    expect(await portas().lembreteDaConferenciaEnviadoEm(RELATO_1)).toBeNull();

    // Agora o envio real: ledger aceito → mensagem enviada. A espera conta a partir do envio.
    const { rows: job } = await pool.query<{ id: string }>(
      `select id from job_queue where organization_id = $1 and source_event_id = $2`,
      [ORG, RELATO_1],
    );
    const { rows: msg } = await pool.query<{ id: string }>(
      `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at, status, sent_via)
       values ($1, $2, $3, $4, 'outbound', 'text', 'Falta só você confirmar…', '2026-11-18T21:05:00Z', 'sent', 'ai') returning id`,
      [ORG, CONVERSA.conversationId, CONTATO, CONVERSA.channelSessionId],
    );
    await pool.query(
      `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status, crm_message_id)
       values ($1, $2, $3, 1, 'h', 'accepted', $4)`,
      [ORG, CONTATO, job[0]!.id, msg[0]!.id],
    );
    expect((await portas().lembreteDaConferenciaEnviadoEm(RELATO_1))?.toISOString()).toBe("2026-11-18T21:05:00.000Z");
    // Mensagem que falhou não é envio.
    await pool.query(`update messages set status = 'failed' where id = $1`, [msg[0]!.id]);
    expect(await portas().lembreteDaConferenciaEnviadoEm(RELATO_1)).toBeNull();
  });

  it("M2: o aviso à Central é UM por resumo (aberto ou resolvido), e o tick fecha o de resumo que já não espera", async () => {

    expect(await portas().avisarResumoSemConfirmacao(RELATO_1)).toBe(true);
    expect(await portas().avisarResumoSemConfirmacao(RELATO_1)).toBe(false);
    await pool.query(`update agent_inbox_items set status = 'resolved' where organization_id = $1`, [ORG]);
    expect(await portas().avisarResumoSemConfirmacao(RELATO_1)).toBe(false); // resolvido não reabre
    expect(await portas().avisarResumoSemConfirmacao(RELATO_2)).toBe(true); // outro resumo, outro aviso

    const { rows } = await pool.query<{ kind: string; ref_kind: string; title: string }>(
      `select kind, ref_kind, title from agent_inbox_items where organization_id = $1 order by created_at`,
      [ORG],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "agenda_sem_resposta" && r.ref_kind === "agenda_relatos")).toBe(true);

    // Fechar: o aviso aberto do RELATO_2 fecha quando o relato deixa de esperar (conferido); um que espera fica aberto.
    const agora = new Date("2026-11-18T22:00:00Z");
    await pool.query(
      `insert into agenda_relatos (id, organization_id, contact_id, texto, lido, janela_de, janela_ate, estado, created_at)
       values ($1, $2, $3, 't', '{}'::jsonb, '2026-11-19', '2026-11-19', 'lido', '2026-11-18T20:00:00Z') on conflict (id) do nothing`,
      [RELATO_2, ORG, CONTATO],
    );
    expect(await portas().fecharAvisosDeResumoResolvidos(agora, 12)).toBe(0); // ainda espera o "sim"
    await pool.query(`update agenda_relatos set estado = 'conferido', conferido_em = now() where id = $1`, [RELATO_2]);
    expect(await portas().fecharAvisosDeResumoResolvidos(agora, 12)).toBe(1);
    const { rows: abertos } = await pool.query(
      `select count(*)::int as n from agent_inbox_items where organization_id = $1 and status = 'open'`,
      [ORG],
    );
    expect(abertos[0].n).toBe(0);
  });

  it("M2: aviso de resumo VENCIDO (lido, mas com mais de 12 h) também fecha", async () => {
    await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
    await pool.query(
      `insert into agenda_relatos (id, organization_id, contact_id, texto, lido, janela_de, janela_ate, estado, created_at)
       values ($1, $2, $3, 't', '{}'::jsonb, '2026-11-19', '2026-11-19', 'lido', '2026-11-18T05:00:00Z') on conflict (id) do nothing`,
      [RELATO_3, ORG, CONTATO],
    );
    expect(await portas().avisarResumoSemConfirmacao(RELATO_3)).toBe(true);
    expect(await portas().fecharAvisosDeResumoResolvidos(new Date("2026-11-18T22:00:00Z"), 12)).toBe(1);
  });
});
