import { describe, expect, it, vi } from "vitest";

import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";

describe("extrairAtribuicaoMeta — referral do webhook oficial", () => {
  it("extrai um referral de anúncio na forma documentada (snake_case)", () => {
    const r = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "120210000000000",
      source_url: "https://fb.me/anuncio123",
      headline: "Agende sua consulta",
      body: "Clique e fale com a gente",
      ctwa_clid: "AfE...clid",
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "AfE...clid",
      titulo: "Agende sua consulta",
      corpo: "Clique e fale com a gente",
      sourceUrl: "https://fb.me/anuncio123",
      bruto: expect.objectContaining({ source_type: "ad" }),
    });
  });

  it("aceita camelCase (caso o agregador normalize)", () => {
    const r = extrairAtribuicaoMeta({
      sourceType: "ad",
      ctwaClid: "clid-123",
      sourceUrl: "https://fb.me/x",
    });
    expect(r?.sourceId).toBe("clid-123");
    expect(r?.sourceUrl).toBe("https://fb.me/x");
  });

  it("cai pra source_id quando não há ctwa_clid", () => {
    const r = extrairAtribuicaoMeta({ source_type: "ad", source_id: "abc" });
    expect(r?.sourceId).toBe("abc");
  });

  it("rejeita source_type 'post' — orgânico, não anúncio pago", () => {
    expect(extrairAtribuicaoMeta({ source_type: "post", source_id: "abc" })).toBeNull();
  });

  it("nulo quando não há nenhum campo que identifique o anúncio", () => {
    expect(extrairAtribuicaoMeta({ body: "só um corpo, sem id nem título nem url" })).toBeNull();
  });

  it("nulo pra payload ausente/vazio/tipo errado", () => {
    expect(extrairAtribuicaoMeta(null)).toBeNull();
    expect(extrairAtribuicaoMeta(undefined)).toBeNull();
    expect(extrairAtribuicaoMeta("string crua")).toBeNull();
    expect(extrairAtribuicaoMeta([])).toBeNull();
  });
});

describe("extrairAtribuicaoWaha — o formato REAL do webhook (campanha da Meta, 06/11/2026)", () => {
  // A estrutura abaixo foi lida do webhook de uma campanha real (só os nomes de
  // chave e as categorias; nada de pessoa). A chave é `externalAdReply` — o
  // extrator procurava `externalAdReplyInfo` e por isso NENHUM anúncio real foi
  // reconhecido: o contato nascia sem origem.
  const mensagemReal = (sourceType = "ad") => ({
    extendedTextMessage: {
      text: "Olá! Posso saber mais informações sobre o clareamento dental?",
      contextInfo: {
        entryPointConversionSource: "ctwa_ad",
        entryPointConversionApp: "facebook",
        conversionSource: "FB_Ads",
        ctwaPayload: "payload-opaco",
        externalAdReply: {
          title: "Clareamento dental",
          body: "Agende sua avaliação",
          mediaType: "IMAGE",
          sourceType,
          sourceApp: "facebook",
          sourceId: "120210000000000",
          sourceUrl: "https://fb.me/abc123",
          ctwaClid: "AfQ-clid-do-clique",
          showAdAttribution: true,
        },
      },
    },
    messageContextInfo: { messageSecret: "x" },
  });

  it("reconhece a campanha: plataforma, título, corpo, url e o clique", () => {
    expect(extrairAtribuicaoWaha(mensagemReal())).toEqual({
      plataforma: "meta_ads",
      sourceId: "AfQ-clid-do-clique",
      titulo: "Clareamento dental",
      corpo: "Agende sua avaliação",
      sourceUrl: "https://fb.me/abc123",
      bruto: expect.objectContaining({ sourceType: "ad", sourceApp: "facebook" }),
    });
  });

  it("o mesmo formato, mas de post orgânico, NÃO vira anúncio", () => {
    expect(extrairAtribuicaoWaha(mensagemReal("post"))).toBeNull();
  });

  it("acha o anúncio também quando o clique chega como áudio ou documento", () => {
    const real = mensagemReal().extendedTextMessage.contextInfo;
    expect(extrairAtribuicaoWaha({ audioMessage: { contextInfo: real } })?.titulo).toBe(
      "Clareamento dental",
    );
    expect(extrairAtribuicaoWaha({ documentMessage: { contextInfo: real } })?.plataforma).toBe(
      "meta_ads",
    );
  });

  it("um contextInfo de RESPOSTA que vem antes não esconde o anúncio do irmão", () => {
    const real = mensagemReal().extendedTextMessage.contextInfo;
    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: { contextInfo: { stanzaId: "resposta" } },
        imageMessage: { contextInfo: real },
      })?.titulo,
    ).toBe("Clareamento dental");
  });
});

describe("extrairAtribuicaoWaha — clique de anúncio SEM o cartão (10/11/2026)", () => {
  // Lido do webhook real da clínica: a mensagem de um clique chegou com os sinais da Meta
  // (`conversionSource: FB_Ads`, `ctwaPayload`, `ctwaSignals`) mas SEM `externalAdReply` — o WhatsApp
  // às vezes omite o cartão do anúncio. O extrator só reconhecia o cartão, e o contato (uma pessoa que
  // clicou num anúncio pago) nasceu como "whatsapp" e sumiu do relatório de campanhas.
  const semCartao = (extra: Record<string, unknown> = {}) => ({
    extendedTextMessage: {
      text: "Olá! Posso saber mais informações sobre o clareamento dental?",
      contextInfo: {
        conversionSource: "FB_Ads",
        conversionData: "dado-opaco",
        ctwaPayload: "payload-opaco",
        ctwaSignals: "all,all",
        ...extra,
      },
    },
    messageContextInfo: { messageSecret: "x" },
  });

  it("reconhece como anúncio da Meta, sem título nem código (a mensagem não os traz)", () => {
    expect(extrairAtribuicaoWaha(semCartao())).toEqual({
      plataforma: "meta_ads",
      sourceId: null,
      titulo: null,
      corpo: null,
      sourceUrl: null,
      bruto: expect.objectContaining({ conversionSource: "FB_Ads", ctwaSignals: "all,all" }),
    });
  });

  it("guarda só o que prova o clique — nunca o corpo da mensagem", () => {
    const r = extrairAtribuicaoWaha(semCartao());
    expect(JSON.stringify(r?.bruto)).not.toContain("clareamento");
  });

  it("com o cartão presente, o cartão vence (título, código e clique continuam lidos)", () => {
    const r = extrairAtribuicaoWaha(
      semCartao({ externalAdReply: { sourceType: "ad", title: "Clareamento dental", sourceId: "1202" } }),
    );
    expect(r?.titulo).toBe("Clareamento dental");
    expect(r?.bruto).toMatchObject({ sourceId: "1202" });
  });

  it("um cartão de post ORGÂNICO continua não sendo anúncio, mesmo com o sinal na mensagem", () => {
    expect(
      extrairAtribuicaoWaha(semCartao({ externalAdReply: { sourceType: "post", title: "Promo" } })),
    ).toBeNull();
  });

  it("só 'conversionSource' de anúncio conta: outro valor, vazio ou ausente não carimba", () => {
    expect(extrairAtribuicaoWaha(semCartao({ conversionSource: "organic" }))).toBeNull();
    expect(extrairAtribuicaoWaha(semCartao({ conversionSource: "" }))).toBeNull();
    expect(
      extrairAtribuicaoWaha({ extendedTextMessage: { contextInfo: { ctwaSignals: "all,all" } } }),
    ).toBeNull();
  });

  it("acha o sinal também em áudio, imagem ou documento", () => {
    const ctx = semCartao().extendedTextMessage.contextInfo;
    expect(extrairAtribuicaoWaha({ audioMessage: { contextInfo: ctx } })?.plataforma).toBe("meta_ads");
    expect(extrairAtribuicaoWaha({ imageMessage: { contextInfo: ctx } })?.plataforma).toBe("meta_ads");
  });
});

describe("extrairAtribuicaoWaha — externalAdReplyInfo do Baileys (forma antiga, ainda aceita)", () => {
  it("extrai de extendedTextMessage.contextInfo.externalAdReplyInfo", () => {
    const r = extrairAtribuicaoWaha({
      extendedTextMessage: {
        text: "Olá, vim do anúncio",
        contextInfo: {
          externalAdReplyInfo: {
            title: "Agende sua consulta",
            body: "Clique e fale com a gente",
            sourceId: "ad-999",
            sourceUrl: "https://fb.me/anuncio123",
            ctwaClid: "clid-999",
          },
        },
      },
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "clid-999",
      titulo: "Agende sua consulta",
      corpo: "Clique e fale com a gente",
      sourceUrl: "https://fb.me/anuncio123",
      bruto: expect.objectContaining({ ctwaClid: "clid-999" }),
    });
  });

  it("também procura em imageMessage/videoMessage.contextInfo", () => {
    const r = extrairAtribuicaoWaha({
      imageMessage: {
        contextInfo: { externalAdReplyInfo: { sourceId: "ad-1", title: "X" } },
      },
    });
    expect(r?.sourceId).toBe("ad-1");
  });

  it("nulo quando é uma mensagem comum, sem contextInfo de anúncio", () => {
    expect(extrairAtribuicaoWaha({ conversation: "oi, tudo bem?" })).toBeNull();
    expect(
      extrairAtribuicaoWaha({ extendedTextMessage: { text: "oi", contextInfo: {} } }),
    ).toBeNull();
  });

  it("post ORGÂNICO compartilhado não é anúncio — o mesmo filtro do irmão oficial", () => {
    // Sem este filtro, o primeiro compartilhamento de um post carimba
    // `meta_ads` no contato — e a guarda de primeiro toque torna isso
    // irreversível pelo caminho normal. O extrator da API oficial já filtrava
    // por `source_type`; este não, e a assimetria não tinha razão escrita.
    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: {
          text: "oi",
          contextInfo: {
            externalAdReplyInfo: { sourceType: "post", title: "Promo", ctwaClid: "x" },
          },
        },
      }),
    ).toBeNull();

    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: {
          text: "oi",
          contextInfo: {
            externalAdReplyInfo: { sourceType: "ad", title: "Promo", ctwaClid: "x" },
          },
        },
      }),
    ).toMatchObject({ plataforma: "meta_ads", sourceId: "x", titulo: "Promo" });
  });

  it("nulo pra payload ausente/tipo errado", () => {
    expect(extrairAtribuicaoWaha(null)).toBeNull();
    expect(extrairAtribuicaoWaha(undefined)).toBeNull();
    expect(extrairAtribuicaoWaha("string crua")).toBeNull();
  });
});

describe("estamparAtribuicaoDoContato", () => {
  it("chama a RPC com plataforma e metadata montados a partir da atribuição", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const admin = { rpc } as never;

    await estamparAtribuicaoDoContato(admin, "contact-1", {
      plataforma: "meta_ads",
      sourceId: "clid-1",
      titulo: "Título",
      corpo: "Corpo",
      sourceUrl: "https://fb.me/x",
      bruto: { fonte: "teste" },
    });

    expect(rpc).toHaveBeenCalledWith(
      "fn_estampar_atribuicao_de_anuncio",
      expect.objectContaining({
        p_contact: "contact-1",
        p_platform: "meta_ads",
        p_metadata: expect.objectContaining({
          ad_platform: "meta_ads",
          ad_source_id: "clid-1",
          ad_title: "Título",
          ad_body: "Corpo",
          ad_source_url: "https://fb.me/x",
          ad_raw: { fonte: "teste" },
        }),
      }),
    );
  });

  it("não lança quando a RPC falha — só registra o erro", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const admin = { rpc } as never;

    await expect(
      estamparAtribuicaoDoContato(admin, "contact-1", {
        plataforma: "meta_ads",
        sourceId: null,
        titulo: null,
        corpo: null,
        sourceUrl: null,
        bruto: {},
      }),
    ).resolves.toBeUndefined();
  });
});
