import { describe, expect, it } from "vitest";

import { ackToStatus } from "@/lib/types/messaging";
import { dispatchWahaEvent, ERRO_DE_ENTREGA } from "@/lib/waha/ingest";

/**
 * O ERRO DE ENTREGA DO WHATSAPP FALHA NA HORA.
 *
 * Achado em produção (3/11/2026): um link mandado a um grupo ficou com o relógio e, 5 minutos depois, com
 * "Falhou — Envio não confirmado em 5 min". No banco: `ack = -1` (ERRO do WAHA), `external_id` gravado,
 * sessão WORKING. O WhatsApp TINHA respondido que recusou; o CRM tratava ack negativo como "enviando"
 * (`ackToStatus` só conhecia 0..3) e deixava para o cron `recover-stuck-messages` dar a causa errada.
 * Das 8 mensagens de atendente para grupos nos 3 dias anteriores, 5 não passaram de "enviando"/"falhou".
 *
 * Aqui se mede (1) o mapa ack → status e (2) o que `message.ack` escreve no banco — com um banco falso
 * que grava o que recebe, sem rede e com relógio que não importa.
 */

describe("ackToStatus — o mapa do ack do WAHA", () => {
  const casos: Array<[number | null | undefined, string]> = [
    [-1, "failed"], // ERRO: o WhatsApp recusou
    [-5, "failed"], // qualquer negativo é erro
    [0, "sending"], // pendente
    [1, "sent"], // chegou ao servidor
    [2, "delivered"], // chegou ao aparelho
    [3, "read"], // lida
    [4, "read"], // tocada (áudio) vale como lida
    [null, "sent"], // sem ack: comportamento de sempre
    [undefined, "sent"],
  ];
  it.each(casos)("ack %s → %s", (ack, esperado) => {
    expect(ackToStatus(ack)).toBe(esperado);
  });
});

interface Chamada {
  tabela: string;
  update: Record<string, unknown>;
  filtros: unknown[][];
  select: string | undefined;
}

/** Um banco que anota cada UPDATE (com os filtros e se pediu linhas de volta) e cada evento emitido. */
function bancoFalso(linhasDevolvidas: Array<{ id: string; conversation_id: string | null }> = []) {
  const chamadas: Chamada[] = [];
  const eventos: Array<Record<string, unknown>> = [];
  const admin = {
    from(tabela: string) {
      return {
        update(update: Record<string, unknown>) {
          const reg: Chamada = { tabela, update, filtros: [], select: undefined };
          chamadas.push(reg);
          const b: Record<string, unknown> = {};
          b.eq = (c: string, v: unknown) => (reg.filtros.push(["eq", c, v]), b);
          b.in = (c: string, v: unknown) => (reg.filtros.push(["in", c, v]), b);
          b.not = (c: string, op: string, v: unknown) => (reg.filtros.push(["not", c, op, v]), b);
          b.select = (cols: string) => ((reg.select = cols), b);
          b.then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: reg.select ? linhasDevolvidas : null, error: null });
          return b;
        },
      };
    },
    rpc(nome: string, args: Record<string, unknown>) {
      eventos.push({ nome, ...args });
      return Promise.resolve({ error: null });
    },
  };
  return { admin, chamadas, eventos };
}

const SESSAO = { id: "s1", organization_id: "org-1", is_warmup_complete: null, warmup_started_at: null };
// `{fromMe}_{chatId}_{idCurto}` — o formato do ack de uma mensagem NOSSA num grupo (a cauda é o id curto).
const ID_DO_ACK = "true_120363000000000001@g.us_3EB0ABC123";

async function receberAck(banco: ReturnType<typeof bancoFalso>, ack: number) {
  await dispatchWahaEvent(
    banco.admin as never,
    SESSAO as never,
    { event: "message.ack", payload: { id: ID_DO_ACK, ack, ackName: ack < 0 ? "ERROR" : "SERVER" } } as never,
    "req-1",
  );
}

describe("message.ack de ERRO (-1)", () => {
  it("marca a mensagem como falha NA HORA, com o motivo verdadeiro e o ack guardado", async () => {
    const banco = bancoFalso([{ id: "m1", conversation_id: "c1" }]);
    await receberAck(banco, -1);

    expect(banco.chamadas).toHaveLength(1);
    const c = banco.chamadas[0]!;
    expect(c.tabela).toBe("messages");
    expect(c.update).toMatchObject({
      ack: -1,
      status: "failed",
      error_code: ERRO_DE_ENTREGA.codigo,
      error_message: ERRO_DE_ENTREGA.mensagem,
    });
    // E NÃO a causa errada que o cron dava.
    expect(String(c.update.error_message)).not.toMatch(/não confirmado|5 min/i);
    expect(c.update.error_code).not.toBe("send_timeout");
  });

  it("só toca no que é NOSSO, da organização da sessão, e que o celular ainda não confirmou", async () => {
    const banco = bancoFalso([{ id: "m1", conversation_id: "c1" }]);
    await receberAck(banco, -1);
    const f = banco.chamadas[0]!.filtros;

    expect(f).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(f).toContainEqual(["eq", "direction", "outbound"]);
    // Um erro atrasado não desfaz uma entrega/leitura já confirmada.
    expect(f).toContainEqual(["not", "status", "in", "(delivered,read)"]);
    // Casa o id completo do ack E a cauda (NOWEB grava o id curto; WEBJS, o completo).
    expect(f).toContainEqual(["in", "external_id", [ID_DO_ACK, "3EB0ABC123"]]);
  });

  it("emite `message.failed` (regra W-12) só das linhas que esta chamada marcou", async () => {
    const banco = bancoFalso([
      { id: "m1", conversation_id: "c1" },
      { id: "m2", conversation_id: null },
    ]);
    await receberAck(banco, -1);

    expect(banco.eventos).toHaveLength(2);
    expect(banco.eventos[0]).toMatchObject({
      nome: "emit_event",
      p_event_type: "message.failed",
      p_entity_kind: "message",
      p_entity_id: "m1",
      p_organization_id: "org-1",
      p_payload: { message_id: "m1", conversation_id: "c1", reason: "ack_error" },
    });
    expect(banco.eventos[1]).toMatchObject({ p_entity_id: "m2" });
  });

  it("se nenhuma linha foi marcada (já entregue/lida, ou ack de outra coisa), não emite evento", async () => {
    const banco = bancoFalso([]);
    await receberAck(banco, -1);
    expect(banco.eventos).toHaveLength(0);
  });
});

describe("os outros acks seguem como sempre (o conserto não tocou neles)", () => {
  it("ack 1 (servidor): `sent`, sem mensagem de erro, sem filtro extra e sem evento", async () => {
    const banco = bancoFalso([{ id: "m1", conversation_id: "c1" }]);
    await receberAck(banco, 1);
    const c = banco.chamadas[0]!;
    expect(c.update).toEqual({ ack: 1, status: "sent" });
    expect(c.select).toBeUndefined();
    expect(c.filtros.some((f) => f[0] === "not" || f[1] === "direction")).toBe(false);
    expect(banco.eventos).toHaveLength(0);
  });

  it("ack 0 (pendente): continua `sending`", async () => {
    const banco = bancoFalso();
    await receberAck(banco, 0);
    expect(banco.chamadas[0]!.update).toEqual({ ack: 0, status: "sending" });
    expect(banco.eventos).toHaveLength(0);
  });

  it("ack 2 e 3: entregue e lida, com a hora carimbada", async () => {
    const entregue = bancoFalso();
    await receberAck(entregue, 2);
    expect(entregue.chamadas[0]!.update).toMatchObject({ ack: 2, status: "delivered" });
    expect(entregue.chamadas[0]!.update.delivered_at).toEqual(expect.any(String));

    const lida = bancoFalso();
    await receberAck(lida, 3);
    expect(lida.chamadas[0]!.update).toMatchObject({ ack: 3, status: "read" });
    expect(lida.chamadas[0]!.update.read_at).toEqual(expect.any(String));
  });
});
