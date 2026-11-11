import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

/**
 * 0226 — mensagem IMPORTADA do histórico do WhatsApp não vira evento de "mensagem nova".
 *
 * O gatilho `trg_messages_emit_event` grava `message.received`/`message.outbound` a cada INSERT, e os consumidores
 * desse evento (sentimento pago, automações, follow-up) tratariam conversa de meses atrás como mensagem de agora.
 * Duas promessas:
 *   1. a linha marcada `metadata.historico_importado = true` NÃO gera evento (nem inbound, nem outbound);
 *   2. a mensagem normal continua gerando exatamente UM — a cerca não pode desligar o evento de todo mundo.
 */
const NORMAL_ENTRADA = "aaaaaaaa-0000-4000-8000-0000000000e1";
const IMPORTADA_ENTRADA = "aaaaaaaa-0000-4000-8000-0000000000e2";
const IMPORTADA_SAIDA = "aaaaaaaa-0000-4000-8000-0000000000e3";
const NORMAL_SAIDA = "aaaaaaaa-0000-4000-8000-0000000000e4";
// `historico_importado` com outro valor (ex.: "false") não pode silenciar: só o `true` literal.
const MARCA_FALSA = "aaaaaaaa-0000-4000-8000-0000000000e5";

const eventos = (id: string): number =>
  Number(sql(`select count(*) from public.event_log where entity_kind = 'message' and entity_id = '${id}';`).trim());

const inserir = (id: string, direcao: "inbound" | "outbound", metadata: string) =>
  sql(`insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, body, sent_at, metadata)
       values
        ('${id}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
         'text', '${direcao}', '${direcao === "inbound" ? "delivered" : "sent"}', 'external_device', 'oi',
         timestamptz '2025-03-01 10:00:00Z', '${metadata}'::jsonb);`);

beforeAll(() => {
  seedGov();
  inserir(NORMAL_ENTRADA, "inbound", "{}");
  inserir(IMPORTADA_ENTRADA, "inbound", '{"historico_importado": true}');
  inserir(IMPORTADA_SAIDA, "outbound", '{"historico_importado": true}');
  inserir(NORMAL_SAIDA, "outbound", "{}");
  inserir(MARCA_FALSA, "inbound", '{"historico_importado": false}');
});

describe("0226 · histórico importado não emite evento de mensagem", () => {
  it("a mensagem importada (entrada) não gera evento", () => {
    expect(eventos(IMPORTADA_ENTRADA)).toBe(0);
  });

  it("a mensagem importada (saída) não gera evento", () => {
    expect(eventos(IMPORTADA_SAIDA)).toBe(0);
  });

  it("a mensagem normal continua gerando exatamente um evento (a cerca morde, não desliga tudo)", () => {
    expect(eventos(NORMAL_ENTRADA)).toBe(1);
    expect(eventos(NORMAL_SAIDA)).toBe(1);
  });

  it("só o `true` literal silencia: a marca falsa não esconde mensagem de verdade", () => {
    expect(eventos(MARCA_FALSA)).toBe(1);
  });
});
