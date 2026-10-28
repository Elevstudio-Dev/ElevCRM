/**
 * ENCAMINHAR: O QUE PODE IR, QUANTO DE UMA VEZ, E O QUE FICA MARCADO.
 *
 * Num CRM de clínica, encaminhar é um dado de uma pessoa chegando à conversa de outra. As regras abaixo
 * são o que impede o encaminhamento de mandar o que nunca chegou ao cliente, o que ele apagou, ou um
 * tipo de mensagem que a cópia distorceria.
 */
import { describe, expect, it } from "vitest";

import {
  foiEncaminhada,
  MAX_DESTINOS_POR_ENCAMINHAMENTO,
  MAX_MENSAGENS_POR_ENCAMINHAMENTO,
  metadataDoEncaminhamento,
  podeEncaminhar,
  TEXTO_DO_MOTIVO,
  validarPedido,
} from "@/lib/messaging/encaminhar";

type Entrada = Parameters<typeof podeEncaminhar>[0];
const base: Entrada = {
  type: "text",
  body: "oi",
  revoked_at: null,
  status: "delivered",
  media_storage_path: null,
  media_url: null,
};
const m = (over: Partial<Entrada>): Entrada => ({ ...base, ...over });

describe("podeEncaminhar", () => {
  it("texto com conteúdo pode", () => {
    expect(podeEncaminhar(m({}))).toEqual({ ok: true });
  });

  it.each(["image", "audio", "video", "document", "sticker"])(
    "%s com o arquivo no nosso armazenamento pode",
    (type) => {
      expect(podeEncaminhar(m({ type, body: null, media_storage_path: "org/conv/x" }))).toEqual({ ok: true });
    },
  );

  it("arquivo que só tem a URL do provider NÃO pode (não há o que copiar; ela expira)", () => {
    expect(podeEncaminhar(m({ type: "image", body: null, media_url: "http://waha/x" }))).toEqual({
      ok: false,
      motivo: "sem_arquivo",
    });
  });

  it("apagada NÃO pode — nem o texto, nem a legenda voltam por aqui", () => {
    expect(podeEncaminhar(m({ revoked_at: "2026-10-27T10:00:00Z" }))).toEqual({ ok: false, motivo: "apagada" });
    expect(
      podeEncaminhar(m({ type: "image", media_storage_path: "p", revoked_at: "2026-10-27T10:00:00Z" })),
    ).toEqual({ ok: false, motivo: "apagada" });
  });

  it("o que nunca chegou ao cliente (falhou) NÃO pode", () => {
    expect(podeEncaminhar(m({ status: "failed" }))).toEqual({ ok: false, motivo: "falhou" });
  });

  it.each(["contact", "location", "template", "tipo-novo"])(
    "%s ainda não: a cópia perderia ou distorceria o que ele carrega",
    (type) => {
      expect(podeEncaminhar(m({ type, media_storage_path: "p" }))).toEqual({
        ok: false,
        motivo: "tipo_nao_suportado",
      });
    },
  );

  it("texto vazio não é mensagem", () => {
    expect(podeEncaminhar(m({ body: "   " }))).toEqual({ ok: false, motivo: "sem_conteudo" });
    expect(podeEncaminhar(m({ body: null }))).toEqual({ ok: false, motivo: "sem_conteudo" });
  });

  it("todo motivo tem texto para a tela", () => {
    for (const motivo of ["apagada", "falhou", "tipo_nao_suportado", "sem_arquivo", "sem_conteudo"] as const) {
      expect(TEXTO_DO_MOTIVO[motivo].length).toBeGreaterThan(10);
    }
  });
});

describe("validarPedido", () => {
  const ids = (n: number, p = "a") => Array.from({ length: n }, (_, i) => `${p}${i}`);

  it("dentro dos tetos passa", () => {
    expect(validarPedido(ids(MAX_MENSAGENS_POR_ENCAMINHAMENTO), ids(MAX_DESTINOS_POR_ENCAMINHAMENTO, "d"))).toEqual({
      ok: true,
    });
  });

  it("vazio dos dois lados é recusado", () => {
    expect(validarPedido([], ["d"])).toMatchObject({ ok: false, codigo: "sem_mensagens" });
    expect(validarPedido(["a"], [])).toMatchObject({ ok: false, codigo: "sem_destino" });
  });

  it("um a mais que o teto é recusado — dos dois lados", () => {
    expect(validarPedido(ids(MAX_MENSAGENS_POR_ENCAMINHAMENTO + 1), ["d"])).toMatchObject({
      ok: false,
      codigo: "mensagens_demais",
    });
    expect(validarPedido(["a"], ids(MAX_DESTINOS_POR_ENCAMINHAMENTO + 1, "d"))).toMatchObject({
      ok: false,
      codigo: "destinos_demais",
    });
  });

  it("repetido é recusado (mandaria a mesma coisa duas vezes à mesma pessoa)", () => {
    expect(validarPedido(["a", "a"], ["d"])).toMatchObject({ ok: false, codigo: "duplicado" });
    expect(validarPedido(["a"], ["d", "d"])).toMatchObject({ ok: false, codigo: "duplicado" });
  });

  it("os tetos são os que o WhatsApp usa (5 conversas) e não passam de rajada", () => {
    expect(MAX_DESTINOS_POR_ENCAMINHAMENTO).toBe(5);
    expect(MAX_MENSAGENS_POR_ENCAMINHAMENTO).toBeLessThanOrEqual(10);
  });
});

describe("a marca do encaminhamento", () => {
  it("diz de onde veio e que é um encaminhamento", () => {
    const meta = metadataDoEncaminhamento({ id: "msg-1", conversation_id: "conv-1" });
    expect(meta).toEqual({
      forwarded: true,
      forwarded_from_message_id: "msg-1",
      forwarded_from_conversation_id: "conv-1",
    });
    expect(foiEncaminhada(meta)).toBe(true);
  });

  it("só `forwarded: true` conta — nada que se pareça", () => {
    expect(foiEncaminhada({})).toBe(false);
    expect(foiEncaminhada(null)).toBe(false);
    expect(foiEncaminhada(undefined)).toBe(false);
    expect(foiEncaminhada({ forwarded: "true" })).toBe(false);
    expect(foiEncaminhada({ forwarded: 1 })).toBe(false);
  });
});
