import { describe, expect, it } from "vitest";

import { anuncioDoContato } from "@/lib/leads/anuncio-do-contato";

// A forma de `source_metadata` gravada pelo estampador (lida da VPS em 09/11/2026; só chaves e categorias).
const metadata = (extra: Record<string, unknown> = {}) => ({
  ad_platform: "meta_ads",
  ad_source_id: "AfQ-clid-do-clique",
  ad_title: "Tire suas dúvidas sobre clareamento",
  ad_body: "Agende sua avaliação",
  ad_source_url: "https://www.instagram.com/p/abc/",
  ad_captured_at: "2026-11-09T15:35:00.000Z",
  ad_raw: { sourceId: "120210000000000", sourceApp: "instagram", thumbnail: "AAAA".repeat(1000) },
  ...extra,
});

describe("anuncioDoContato", () => {
  it("monta o anúncio com app, título, texto, link, código do anúncio e hora do clique", () => {
    expect(anuncioDoContato("meta_ads", metadata())).toEqual({
      plataforma: "meta_ads",
      app: "Instagram",
      titulo: "Tire suas dúvidas sobre clareamento",
      texto: "Agende sua avaliação",
      url: "https://www.instagram.com/p/abc/",
      anuncioId: "120210000000000",
      clicadoEm: "2026-11-09T15:35:00.000Z",
    });
  });

  it("o código do ANÚNCIO é o do ad_raw, não o ad_source_id (que é o id do clique, um por pessoa)", () => {
    expect(anuncioDoContato("meta_ads", metadata())?.anuncioId).not.toBe("AfQ-clid-do-clique");
  });

  it("nunca devolve a miniatura em base64", () => {
    expect(JSON.stringify(anuncioDoContato("meta_ads", metadata()))).not.toContain("AAAA");
  });

  it("quando o WhatsApp não diz o app, o app fica nulo (não chuta)", () => {
    expect(anuncioDoContato("meta_ads", metadata({ ad_raw: { sourceId: "1" } }))?.app).toBeNull();
    expect(anuncioDoContato("meta_ads", metadata({ ad_raw: { sourceApp: "tiktok" } }))?.app).toBeNull();
  });

  it("completa título e texto pelo dado bruto quando os campos gravados faltam", () => {
    const r = anuncioDoContato("meta_ads", {
      ad_platform: "meta_ads",
      ad_raw: { title: "Do bruto", body: "Corpo do bruto" },
    });
    expect(r?.titulo).toBe("Do bruto");
    expect(r?.texto).toBe("Corpo do bruto");
  });

  it("só aceita link http(s): javascript: vindo do payload de um terceiro não vira href", () => {
    expect(anuncioDoContato("meta_ads", metadata({ ad_source_url: "javascript:alert(1)" }))?.url).toBeNull();
    expect(anuncioDoContato("meta_ads", metadata({ ad_source_url: "não é url" }))?.url).toBeNull();
    expect(anuncioDoContato("meta_ads", metadata({ ad_source_url: "http://fb.me/x" }))?.url).toBe("http://fb.me/x");
  });

  it("contato que não veio de anúncio devolve nulo", () => {
    expect(anuncioDoContato("whatsapp", {})).toBeNull();
    expect(anuncioDoContato(null, null)).toBeNull();
    expect(anuncioDoContato("qr_code", { qr_code_id: "x" })).toBeNull();
  });

  it("reconhece pelo `source` mesmo sem ad_platform nos metadados (contato antigo)", () => {
    expect(anuncioDoContato("meta_ads", {})?.plataforma).toBe("meta_ads");
  });
});
