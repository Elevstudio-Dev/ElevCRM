/**
 * O SERVIDOR DO ENCAMINHAR — o que ele recusa antes de enviar, o que copia, o que conta e o que audita.
 *
 * Cada cópia sai pelo mesmo caminho de qualquer mensagem do atendente (`sendMessageHandler`, falso aqui:
 * o que se prova é O QUE o encaminhar manda a ele). O erro caro seria mandar o que não devia: o que o
 * cliente apagou, o que nunca chegou a sair, o arquivo de OUTRA conversa — ou mandar só um pedaço do
 * que a pessoa escolheu sem avisar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, copyMock, auditMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  copyMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: sendMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ copy: copyMock }) } }),
}));

import { forwardMessagesHandler } from "@/app/api/v1/messages/forward/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "org-1";
const ORIGEM = "conv-origem";
const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: "user-1" }, requestId: "req-1" };

type Linha = Record<string, unknown>;

/** Um supabase de mentira: `from(t).select().in(col, ids).eq(...)` devolve as linhas da tabela filtradas. */
function fakeSupabase(tabelas: Record<string, Linha[]>) {
  return {
    from: (t: string) => {
      let linhas = tabelas[t] ?? [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: (col: string, valores: string[]) => {
          linhas = linhas.filter((l) => valores.includes(l[col] as string));
          return q;
        },
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(ok),
      };
      return q;
    },
  } as never;
}

function msg(id: string, over: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    conversation_id: ORIGEM,
    type: "text",
    direction: "inbound",
    status: "received",
    body: `texto ${id}`,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    media_url: null,
    revoked_at: null,
    sent_at: "2026-10-27T12:00:00.000Z",
    ...over,
  };
}
const conv = (id: string, over: Linha = {}): Linha => ({
  id,
  status: "open",
  contacts: { name: `Contato ${id}`, is_blocked: false },
  ...over,
});

const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ id: "nova" });
  copyMock.mockReset().mockResolvedValue({ error: null });
  auditMock.mockReset().mockResolvedValue(undefined);
});

describe("o que vai", () => {
  it("texto: sai pelo envio comum, para a conversa de destino, com a marca de encaminhado", async () => {
    const sb = fakeSupabase({ messages: [msg("m1", { body: "  Pode ser quinta?  " })], conversations: [conv("d1")] });
    const r = await forwardMessagesHandler(sb, ctx, { message_ids: ["m1"], destination_conversation_ids: ["d1"] });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, , envio] = sendMock.mock.calls[0]!;
    expect(envio).toMatchObject({
      conversation_id: "d1",
      type: "text",
      body: "Pode ser quinta?",
      metadata: { forwarded: true, forwarded_from_message_id: "m1", forwarded_from_conversation_id: ORIGEM },
    });
    expect(r).toMatchObject({ total_enviadas: 1, total_falhas: 0 });
  });

  it("arquivo: é COPIADO para a conversa de destino — nunca reaproveita o caminho da origem", async () => {
    const origemPath = `${ORG}/${ORIGEM}/abc.ogg`;
    const sb = fakeSupabase({
      messages: [msg("a1", { type: "audio", body: null, media_mime: "audio/ogg", media_size_bytes: 1234, media_storage_path: origemPath })],
      conversations: [conv("d1")],
    });
    await forwardMessagesHandler(sb, ctx, { message_ids: ["a1"], destination_conversation_ids: ["d1"] });

    expect(copyMock).toHaveBeenCalledTimes(1);
    const [de, para] = copyMock.mock.calls[0]!;
    expect(de).toBe(origemPath);
    // Sob {org}/{destino}/ — é o que `sendMessageHandler` exige para aceitar a mídia.
    expect(para).toMatch(new RegExp(`^${ORG}/d1/fwd-[0-9a-f-]{36}\\.ogg$`));
    const [, , envio] = sendMock.mock.calls[0]!;
    expect(envio).toMatchObject({ type: "audio", media_storage_path: para, media_mime: "audio/ogg", media_size_bytes: 1234 });
    expect(envio.body).toBeUndefined();
  });

  it("a legenda da mídia vai junto", async () => {
    const sb = fakeSupabase({
      messages: [msg("f1", { type: "image", body: "o comprovante", media_mime: "image/jpeg", media_storage_path: `${ORG}/${ORIGEM}/f.jpg` })],
      conversations: [conv("d1")],
    });
    await forwardMessagesHandler(sb, ctx, { message_ids: ["f1"], destination_conversation_ids: ["d1"] });
    expect(sendMock.mock.calls[0]![2]).toMatchObject({ type: "image", body: "o comprovante" });
  });

  it("várias mensagens saem NA ORDEM em que foram ditas, para cada destino", async () => {
    const sb = fakeSupabase({
      messages: [
        msg("tarde", { sent_at: "2026-10-27T15:00:00.000Z", body: "segunda" }),
        msg("cedo", { sent_at: "2026-10-27T10:00:00.000Z", body: "primeira" }),
      ],
      conversations: [conv("d1"), conv("d2")],
    });
    // O pedido vem na ordem invertida de propósito.
    await forwardMessagesHandler(sb, ctx, { message_ids: ["tarde", "cedo"], destination_conversation_ids: ["d1", "d2"] });

    const porDestino = (d: string) =>
      sendMock.mock.calls.filter((c) => c[2].conversation_id === d).map((c) => c[2].body);
    expect(porDestino("d1")).toEqual(["primeira", "segunda"]);
    expect(porDestino("d2")).toEqual(["primeira", "segunda"]);
  });
});

describe("o que NÃO vai — e nada sai se alguma não pode", () => {
  it("uma apagada no conjunto: recusa tudo, 422, e NADA é enviado nem copiado", async () => {
    const sb = fakeSupabase({
      messages: [msg("ok"), msg("apagada", { revoked_at: "2026-10-27T13:00:00Z" })],
      conversations: [conv("d1")],
    });
    await expect(
      forwardMessagesHandler(sb, ctx, { message_ids: ["ok", "apagada"], destination_conversation_ids: ["d1"] }),
    ).rejects.toMatchObject({ status: 422, code: "not_forwardable" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(copyMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("a que nunca chegou ao cliente (failed) também recusa", async () => {
    const sb = fakeSupabase({ messages: [msg("f", { status: "failed", direction: "outbound" })], conversations: [conv("d1")] });
    await expect(
      forwardMessagesHandler(sb, ctx, { message_ids: ["f"], destination_conversation_ids: ["d1"] }),
    ).rejects.toMatchObject({ status: 422 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("mensagens de conversas diferentes: recusa (o pedido é de UMA conversa)", async () => {
    const sb = fakeSupabase({
      messages: [msg("a"), msg("b", { conversation_id: "outra" })],
      conversations: [conv("d1")],
    });
    await expect(
      forwardMessagesHandler(sb, ctx, { message_ids: ["a", "b"], destination_conversation_ids: ["d1"] }),
    ).rejects.toMatchObject({ status: 422 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("mensagem que o usuário não enxerga (a RLS a esconde): 404, igual à inexistente", async () => {
    const sb = fakeSupabase({ messages: [msg("a")], conversations: [conv("d1")] });
    await expect(
      forwardMessagesHandler(sb, ctx, { message_ids: ["a", "invisivel"], destination_conversation_ids: ["d1"] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("conversa de destino fora do acesso: 404, e nada sai", async () => {
    const sb = fakeSupabase({ messages: [msg("a")], conversations: [conv("d1")] });
    await expect(
      forwardMessagesHandler(sb, ctx, { message_ids: ["a"], destination_conversation_ids: ["d1", "d-invisivel"] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("os tetos valem ANTES de tocar em qualquer coisa: 6 destinos, 6 mensagens, repetidos", async () => {
    const sb = fakeSupabase({ messages: [], conversations: [] });
    for (const pedido of [
      { message_ids: ["a"], destination_conversation_ids: ids(6, "d") },
      { message_ids: ids(6, "m"), destination_conversation_ids: ["d"] },
      { message_ids: ["a", "a"], destination_conversation_ids: ["d"] },
    ]) {
      await expect(forwardMessagesHandler(sb, ctx, pedido)).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("o arquivo de OUTRA conversa não é copiado (o caminho não é da conversa de origem)", async () => {
    const sb = fakeSupabase({
      messages: [msg("f", { type: "image", body: null, media_mime: "image/png", media_storage_path: `${ORG}/conversa-alheia/x.png` })],
      conversations: [conv("d1")],
    });
    const r = await forwardMessagesHandler(sb, ctx, { message_ids: ["f"], destination_conversation_ids: ["d1"] });
    expect(copyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.total_enviadas).toBe(0);
    expect(r.destinos[0]!.falhas).toHaveLength(1);
  });
});

describe("o que sai e o que não sai, por destino", () => {
  it("destino fechado ou bloqueado: nada sai para ele — e os outros destinos saem", async () => {
    const sb = fakeSupabase({
      messages: [msg("a")],
      conversations: [conv("ok"), conv("fechada", { status: "closed" }), conv("bloq", { contacts: { name: "X", is_blocked: true } })],
    });
    const r = await forwardMessagesHandler(sb, ctx, {
      message_ids: ["a"],
      destination_conversation_ids: ["ok", "fechada", "bloq"],
    });
    expect(sendMock.mock.calls.map((c) => c[2].conversation_id)).toEqual(["ok"]);
    expect(r.total_enviadas).toBe(1);
    expect(r.total_falhas).toBe(2);
    const falhasPorDestino = Object.fromEntries(r.destinos.map((d) => [d.conversation_id, d.falhas[0]?.erro]));
    expect(falhasPorDestino.fechada).toBe("Conversa fechada.");
    expect(falhasPorDestino.bloq).toBe("Contato bloqueado.");
  });

  it("uma falha no meio NÃO derruba as outras, e é CONTADA (não finge que foi tudo)", async () => {
    sendMock
      .mockResolvedValueOnce({ id: "1" })
      .mockRejectedValueOnce(new ApiError(403, "forbidden", undefined, "req", "Contato bloqueou o atendimento."))
      .mockResolvedValueOnce({ id: "3" });
    const sb = fakeSupabase({
      messages: [
        msg("m1", { sent_at: "2026-10-27T10:00:00Z" }),
        msg("m2", { sent_at: "2026-10-27T11:00:00Z" }),
        msg("m3", { sent_at: "2026-10-27T12:00:00Z" }),
      ],
      conversations: [conv("d1")],
    });
    const r = await forwardMessagesHandler(sb, ctx, { message_ids: ["m1", "m2", "m3"], destination_conversation_ids: ["d1"] });
    expect(r).toMatchObject({ total_enviadas: 2, total_falhas: 1 });
    expect(r.destinos[0]!.falhas).toEqual([{ message_id: "m2", erro: "Contato bloqueou o atendimento." }]);
  });
});

describe("a trilha", () => {
  it("uma linha de auditoria por encaminhamento — com quem, de onde, para onde e quantas; SEM o conteúdo", async () => {
    const sb = fakeSupabase({
      messages: [msg("m1", { body: "dado sensível do paciente" })],
      conversations: [conv("d1"), conv("d2")],
    });
    await forwardMessagesHandler(sb, ctx, { message_ids: ["m1"], destination_conversation_ids: ["d1", "d2"] });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "message.forwarded",
      actorUserId: "user-1",
      organizationId: ORG,
      resourceType: "conversation",
      resourceId: ORIGEM,
      metadata: { message_ids: ["m1"], destination_conversation_ids: ["d1", "d2"], total_enviadas: 2, total_falhas: 0 },
    });
    expect(JSON.stringify(entrada)).not.toContain("dado sensível");
  });
});
