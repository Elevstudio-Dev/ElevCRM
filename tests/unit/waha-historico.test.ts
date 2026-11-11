// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoricoIndisponivel } from "@/lib/channels/historico";
import { WahaClient } from "@/lib/waha/client";
import { buscarHistoricoWaha, mensagemDoHistorico, TAMANHO_DA_PAGINA } from "@/lib/waha/historico";

/**
 * O histórico de um chat do WAHA → a forma neutra do CRM.
 *
 * Os payloads seguem a forma REAL do NOWEB (a do webhook, lida na clínica em 06/11/2026): `id` composto, `timestamp`
 * em segundos, o anúncio em `_data.message.<tipo>.contextInfo.externalAdReply`.
 */
const CHAT = "5511999999999@c.us";

const entrada = (over: Record<string, unknown> = {}) => ({
  id: "false_5511999999999@c.us_3EB0AAAA0001",
  timestamp: 1_730_000_000,
  from: CHAT,
  fromMe: false,
  body: "Oi, vi o anúncio",
  hasMedia: false,
  ack: 3,
  _data: { notifyName: "Maria" },
  ...over,
});

const doAnuncio = (over: Record<string, unknown> = {}) =>
  entrada({
    _data: {
      notifyName: "Maria",
      message: {
        extendedTextMessage: {
          text: "Oi, vi o anúncio",
          contextInfo: {
            externalAdReply: {
              title: "Clareamento v1",
              sourceType: "ad",
              ctwaClid: "CLID-123",
              sourceUrl: "https://fb.me/abc",
            },
          },
        },
      },
    },
    ...over,
  });

describe("mensagemDoHistorico", () => {
  it("traduz uma mensagem de entrada: direção, hora ISO, texto, nome e recibo", () => {
    const m = mensagemDoHistorico(entrada(), CHAT);
    expect(m).toMatchObject({
      externalId: "false_5511999999999@c.us_3EB0AAAA0001",
      direcao: "inbound",
      enviadaEm: "2024-10-27T03:33:20.000Z",
      tipo: "text",
      texto: "Oi, vi o anúncio",
      temMidia: false,
      ack: 3,
      nomeDoContato: "Maria",
      anuncio: null,
    });
  });

  it("a mensagem que NÓS mandamos é saída, sem nome de contato e nunca é anúncio", () => {
    const m = mensagemDoHistorico(doAnuncio({ fromMe: true, id: "true_5511999999999@c.us_3EB0BBBB0002" }), CHAT);
    expect(m?.direcao).toBe("outbound");
    expect(m?.nomeDoContato).toBeNull();
    expect(m?.anuncio).toBeNull();
  });

  it("identifica o anúncio: título, código do clique e link", () => {
    const m = mensagemDoHistorico(doAnuncio(), CHAT);
    expect(m?.anuncio).toMatchObject({
      plataforma: "meta_ads",
      titulo: "Clareamento v1",
      sourceId: "CLID-123",
      sourceUrl: "https://fb.me/abc",
    });
  });

  it("clique de anúncio SEM o cartão ainda é anúncio (só os sinais da Meta)", () => {
    const m = mensagemDoHistorico(
      entrada({
        _data: {
          message: {
            extendedTextMessage: { contextInfo: { conversionSource: "FB_Ads", ctwaPayload: "abc" } },
          },
        },
      }),
      CHAT,
    );
    expect(m?.anuncio).toMatchObject({ plataforma: "meta_ads", sourceId: null, titulo: null });
  });

  it("post ORGÂNICO compartilhado não é anúncio", () => {
    const m = mensagemDoHistorico(
      entrada({
        _data: {
          message: {
            extendedTextMessage: {
              contextInfo: { externalAdReply: { title: "Post", sourceType: "post", sourceUrl: "https://ig/x" } },
            },
          },
        },
      }),
      CHAT,
    );
    expect(m?.anuncio).toBeNull();
  });

  it("lista TODOS os ids sob os quais a mesma mensagem pode já estar gravada", () => {
    const m = mensagemDoHistorico(entrada(), CHAT)!;
    expect(m.idsEquivalentes).toEqual(
      expect.arrayContaining([
        "false_5511999999999@c.us_3EB0AAAA0001", // o composto do webhook
        "3EB0AAAA0001", // o cru que o envio do CRM grava
        "true_5511999999999@c.us_3EB0AAAA0001", // o eco do nosso envio
      ]),
    );
  });

  it("o id composto de outro endereço (@lid) também entra nas equivalências", () => {
    const m = mensagemDoHistorico(entrada({ id: "false_250302204792918@lid_3EB0CCCC0003" }), CHAT)!;
    expect(m.idsEquivalentes).toContain("true_250302204792918@lid_3EB0CCCC0003");
    expect(m.idsEquivalentes).toContain("3EB0CCCC0003");
  });

  it("anexo sem legenda é mensagem de mídia, e o arquivo não vem", () => {
    const m = mensagemDoHistorico(
      entrada({ body: "", hasMedia: true, type: "image", mimetype: "image/jpeg" }),
      CHAT,
    );
    expect(m).toMatchObject({ tipo: "image", texto: null, temMidia: true, mediaMime: "image/jpeg" });
  });

  it("descarta o que o CRM não mostraria: sem texto nem anexo, sem hora, sem id, reação", () => {
    expect(mensagemDoHistorico(entrada({ body: "" }), CHAT)).toBeNull();
    expect(mensagemDoHistorico(entrada({ timestamp: undefined }), CHAT)).toBeNull();
    expect(mensagemDoHistorico(entrada({ timestamp: 0 }), CHAT)).toBeNull();
    expect(mensagemDoHistorico(entrada({ id: undefined }), CHAT)).toBeNull();
    expect(mensagemDoHistorico(entrada({ type: "reaction", body: "👍" }), CHAT)).toBeNull();
    expect(mensagemDoHistorico("lixo", CHAT)).toBeNull();
    expect(mensagemDoHistorico(null, CHAT)).toBeNull();
  });
});

describe("buscarHistoricoWaha", () => {
  const pagina = (de: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      entrada({ id: `false_${CHAT}_ID${de + i}`, timestamp: 1_730_000_000 - (de + i), body: `m${de + i}` }),
    );

  it("pagina até a página incompleta e junta tudo", async () => {
    const getChatMessages = vi
      .fn()
      .mockResolvedValueOnce(pagina(0, TAMANHO_DA_PAGINA))
      .mockResolvedValueOnce(pagina(TAMANHO_DA_PAGINA, 30));
    const r = await buscarHistoricoWaha({ getChatMessages }, "sessao", CHAT, 2_000);
    expect(r).toHaveLength(TAMANHO_DA_PAGINA + 30);
    expect(getChatMessages).toHaveBeenCalledTimes(2);
    expect(getChatMessages).toHaveBeenNthCalledWith(2, "sessao", CHAT, { limit: TAMANHO_DA_PAGINA, offset: TAMANHO_DA_PAGINA });
  });

  it("para no teto de mensagens", async () => {
    const getChatMessages = vi.fn().mockImplementation(async (_s, _c, { offset }) => pagina(offset, TAMANHO_DA_PAGINA));
    const r = await buscarHistoricoWaha({ getChatMessages }, "s", CHAT, 150);
    expect(r).toHaveLength(150);
    expect(getChatMessages).toHaveBeenCalledTimes(2);
  });

  it("não fica preso num store que repete a mesma página (offset ignorado)", async () => {
    const mesma = pagina(0, TAMANHO_DA_PAGINA);
    const getChatMessages = vi.fn().mockResolvedValue(mesma);
    const r = await buscarHistoricoWaha({ getChatMessages }, "s", CHAT, 2_000);
    expect(r).toHaveLength(TAMANHO_DA_PAGINA);
    expect(getChatMessages).toHaveBeenCalledTimes(2);
  });

  it("chat sem mensagens devolve lista vazia", async () => {
    const getChatMessages = vi.fn().mockResolvedValue([]);
    expect(await buscarHistoricoWaha({ getChatMessages }, "s", CHAT, 100)).toEqual([]);
  });

  it("o erro do cliente propaga (quem chama decide)", async () => {
    const getChatMessages = vi.fn().mockRejectedValue(new Error("waha_500: x"));
    await expect(buscarHistoricoWaha({ getChatMessages }, "s", CHAT, 100)).rejects.toThrow("waha_500");
  });
});

describe("WahaClient.getChatMessages", () => {
  afterEach(() => vi.restoreAllMocks());

  const cliente = () => new WahaClient("http://waha.test", "chave");

  it("pede a página certa, sem baixar mídia, das mais novas para as mais antigas", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "x" }]), { status: 200 }),
    );
    const r = await cliente().getChatMessages("org_x", CHAT, { limit: 100, offset: 200 });
    expect(r).toEqual([{ id: "x" }]);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe(`/api/org_x/chats/${encodeURIComponent(CHAT)}/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "100",
      offset: "200",
      downloadMedia: "false",
      sortBy: "timestamp",
      sortOrder: "desc",
    });
  });

  it("store desligado vira `waha_store_desligado` (e não um erro de rede genérico)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"message":"Enable NOWEB store \\"config.noweb.store.enabled=True\\" ..."}', { status: 400 }),
    );
    await expect(cliente().getChatMessages("s", CHAT, { limit: 1, offset: 0 })).rejects.toThrow(/^waha_store_desligado/);
  });

  it("outro erro HTTP mantém o código do status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(cliente().getChatMessages("s", CHAT, { limit: 1, offset: 0 })).rejects.toThrow(/^waha_502/);
  });

  it("resposta que não é lista vira lista vazia", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await cliente().getChatMessages("s", CHAT, { limit: 1, offset: 0 })).toEqual([]);
  });
});

describe("wahaAdapter.fetchChatHistory", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/waha/client");
  });

  it("traduz o store desligado para HistoricoIndisponivel", async () => {
    vi.doMock("@/lib/waha/client", async (orig) => ({
      ...(await orig<typeof import("@/lib/waha/client")>()),
      getWahaClient: () => ({
        getChatMessages: async () => {
          throw new Error("waha_store_desligado: x");
        },
      }),
    }));
    const { wahaAdapter } = await import("@/lib/channels/adapters/waha");
    await expect(
      wahaAdapter.fetchChatHistory!({ organizationId: "o", sessionRef: "s", recipient: CHAT, limite: 10 }),
    ).rejects.toBeInstanceOf((await import("@/lib/channels/historico")).HistoricoIndisponivel);
  });

  it("sem transporte configurado NÃO devolve lista vazia (diria que o contato nunca falou)", async () => {
    vi.doMock("@/lib/waha/client", async (orig) => ({
      ...(await orig<typeof import("@/lib/waha/client")>()),
      getWahaClient: () => null,
    }));
    const { wahaAdapter } = await import("@/lib/channels/adapters/waha");
    await expect(
      wahaAdapter.fetchChatHistory!({ organizationId: "o", sessionRef: "s", recipient: CHAT, limite: 10 }),
    ).rejects.toThrow("waha_not_configured");
  });
});

describe("HistoricoIndisponivel", () => {
  it("carrega o código para a rota diferenciar de falha de rede", () => {
    const e = new HistoricoIndisponivel();
    expect(e.codigo).toBe("historico_indisponivel");
    expect(e).toBeInstanceOf(Error);
  });
});
